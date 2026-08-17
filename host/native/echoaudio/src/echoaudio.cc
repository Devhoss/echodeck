// Windows Core Audio for EchoDeck.
//
// Replaces the persistent PowerShell helper that shelled out to the
// AudioDeviceCmdlets module: that module is a separate install the user has to
// find themselves, so "Switch Audio Output" silently failed on any machine
// without it. This runs in-process instead, so there is no child to supervise,
// no startup latency on the first press, and nothing to orphan.

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>

#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// IPolicyConfig
//
// Setting the default endpoint has no supported public API. This interface is
// undocumented but has been stable since Vista, and is what every audio
// switcher on Windows uses — including the AudioDeviceCmdlets module this
// replaces. Declared here rather than linked, since no SDK header ships it.
// ---------------------------------------------------------------------------

const CLSID CLSID_CPolicyConfigClient = {
    0x870af99c, 0x171d, 0x4f9e, {0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9}};

const IID IID_IPolicyConfig = {
    0xf8679f50, 0x850a, 0x41cf, {0x9c, 0x72, 0x43, 0x0f, 0x29, 0x02, 0x90, 0xc8}};

interface IPolicyConfig : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, WAVEFORMATEX*, WAVEFORMATEX*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, struct DeviceShareMode*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, struct DeviceShareMode*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR wszDeviceId, ERole eRole) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

namespace {

// Electron's main thread has already initialised COM, and it may have picked a
// different apartment than we would. Both "already initialised" and "different
// mode" are fine for our purposes; we just must not call CoUninitialize on a
// thread we did not initialise.
class ComScope {
 public:
  ComScope() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    owned_ = SUCCEEDED(hr);
  }
  ~ComScope() {
    if (owned_) CoUninitialize();
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;

 private:
  bool owned_ = false;
};

std::string ToUtf8(PCWSTR w) {
  if (!w) return {};
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1) return {};
  std::string out(static_cast<size_t>(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
  return out;
}

std::wstring ToWide(const std::string& s) {
  if (s.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (len <= 1) return {};
  std::wstring out(static_cast<size_t>(len - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), len);
  return out;
}

const char* StateName(DWORD state) {
  switch (state) {
    case DEVICE_STATE_ACTIVE: return "active";
    case DEVICE_STATE_DISABLED: return "disabled";
    case DEVICE_STATE_NOTPRESENT: return "not_present";
    case DEVICE_STATE_UNPLUGGED: return "unplugged";
    default: return "unknown";
  }
}

EDataFlow FlowFromString(const std::string& direction) {
  return direction == "input" ? eCapture : eRender;
}

ERole RoleFromString(const std::string& role) {
  if (role == "communications") return eCommunications;
  if (role == "console") return eConsole;
  return eMultimedia;
}

// Reads one string property, returning empty on any failure — a device missing
// its friendly name should not fail the whole enumeration.
std::string ReadStringProperty(IPropertyStore* store, const PROPERTYKEY& key) {
  PROPVARIANT v;
  PropVariantInit(&v);
  std::string out;
  if (SUCCEEDED(store->GetValue(key, &v)) && v.vt == VT_LPWSTR) {
    out = ToUtf8(v.pwszVal);
  }
  PropVariantClear(&v);
  return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// listDevices(direction) -> [{ id, name, interfaceName, state, isDefault }]
// ---------------------------------------------------------------------------

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string direction =
      info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "output";
  const EDataFlow flow = FlowFromString(direction);

  ComScope com;

  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr)) {
    Napi::Error::New(env, "Could not create the audio device enumerator")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // The default is looked up separately so each entry can be flagged; a failure
  // here is not fatal, it just means nothing is marked default.
  std::string defaultId;
  IMMDevice* defaultDevice = nullptr;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eMultimedia, &defaultDevice)) &&
      defaultDevice) {
    LPWSTR id = nullptr;
    if (SUCCEEDED(defaultDevice->GetId(&id)) && id) {
      defaultId = ToUtf8(id);
      CoTaskMemFree(id);
    }
    defaultDevice->Release();
  }

  // Include everything, not just active devices: a headset that is currently
  // off still needs to be selectable, so a button configured for it keeps
  // working when it comes back.
  IMMDeviceCollection* collection = nullptr;
  hr = enumerator->EnumAudioEndpoints(flow, DEVICE_STATEMASK_ALL, &collection);
  if (FAILED(hr) || !collection) {
    enumerator->Release();
    Napi::Error::New(env, "Could not enumerate audio endpoints").ThrowAsJavaScriptException();
    return env.Null();
  }

  UINT count = 0;
  collection->GetCount(&count);

  // Grown rather than presized: unnamed husks are skipped below, so the final
  // length is not known up front and presizing would leave undefined holes.
  Napi::Array result = Napi::Array::New(env);
  uint32_t written = 0;

  for (UINT i = 0; i < count; i++) {
    IMMDevice* device = nullptr;
    if (FAILED(collection->Item(i, &device)) || !device) continue;

    LPWSTR rawId = nullptr;
    std::string id;
    if (SUCCEEDED(device->GetId(&rawId)) && rawId) {
      id = ToUtf8(rawId);
      CoTaskMemFree(rawId);
    }

    DWORD state = DEVICE_STATE_NOTPRESENT;
    device->GetState(&state);

    std::string name, interfaceName;
    IPropertyStore* store = nullptr;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) && store) {
      name = ReadStringProperty(store, PKEY_Device_FriendlyName);
      interfaceName = ReadStringProperty(store, PKEY_DeviceInterface_FriendlyName);
      store->Release();
    }

    // Windows keeps registry husks for endpoints it can no longer describe.
    // They have an id and a state but no friendly name, so there is nothing to
    // show in a picker and nothing a user could meaningfully choose.
    if (name.empty()) {
      device->Release();
      continue;
    }

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("id", Napi::String::New(env, id));
    entry.Set("name", Napi::String::New(env, name));
    entry.Set("interfaceName", Napi::String::New(env, interfaceName));
    entry.Set("state", Napi::String::New(env, StateName(state)));
    entry.Set("direction", Napi::String::New(env, direction == "input" ? "input" : "output"));
    entry.Set("isDefault", Napi::Boolean::New(env, !id.empty() && id == defaultId));
    result.Set(written++, entry);

    device->Release();
  }

  collection->Release();
  enumerator->Release();
  return result;
}

// ---------------------------------------------------------------------------
// getDefaultDevice(direction) -> { id, name, ... } | null
// ---------------------------------------------------------------------------

Napi::Value GetDefaultDevice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string direction =
      info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "output";

  ComScope com;

  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(&enumerator)))) {
    Napi::Error::New(env, "Could not create the audio device enumerator")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  IMMDevice* device = nullptr;
  HRESULT hr =
      enumerator->GetDefaultAudioEndpoint(FlowFromString(direction), eMultimedia, &device);
  if (FAILED(hr) || !device) {
    // No default endpoint is a legitimate state (every device unplugged), so
    // this is null rather than an error.
    enumerator->Release();
    return env.Null();
  }

  LPWSTR rawId = nullptr;
  std::string id;
  if (SUCCEEDED(device->GetId(&rawId)) && rawId) {
    id = ToUtf8(rawId);
    CoTaskMemFree(rawId);
  }

  std::string name, interfaceName;
  IPropertyStore* store = nullptr;
  if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) && store) {
    name = ReadStringProperty(store, PKEY_Device_FriendlyName);
    interfaceName = ReadStringProperty(store, PKEY_DeviceInterface_FriendlyName);
    store->Release();
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("id", Napi::String::New(env, id));
  out.Set("name", Napi::String::New(env, name));
  out.Set("interfaceName", Napi::String::New(env, interfaceName));
  out.Set("direction", Napi::String::New(env, direction == "input" ? "input" : "output"));
  out.Set("isDefault", Napi::Boolean::New(env, true));

  device->Release();
  enumerator->Release();
  return out;
}

// ---------------------------------------------------------------------------
// setDefaultDevice(id, role?) -> true
//
// With no role, all three are set. That is what a user means by "switch to my
// headphones": Windows keeps Console, Multimedia and Communications separately,
// and setting only one leaves some apps on the old device.
// ---------------------------------------------------------------------------

Napi::Value SetDefaultDevice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "setDefaultDevice(id) requires a device id")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const std::wstring id = ToWide(info[0].As<Napi::String>().Utf8Value());
  if (id.empty()) {
    Napi::TypeError::New(env, "Device id was empty").ThrowAsJavaScriptException();
    return env.Null();
  }

  const bool allRoles = info.Length() < 2 || !info[1].IsString();
  const ERole role =
      allRoles ? eMultimedia : RoleFromString(info[1].As<Napi::String>().Utf8Value());

  ComScope com;

  IPolicyConfig* policy = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_CPolicyConfigClient, nullptr, CLSCTX_ALL,
                                IID_IPolicyConfig, reinterpret_cast<void**>(&policy));
  if (FAILED(hr) || !policy) {
    Napi::Error::New(env, "Could not reach the Windows audio policy service")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const ERole roles[] = {eConsole, eMultimedia, eCommunications};
  HRESULT last = S_OK;
  if (allRoles) {
    for (ERole r : roles) {
      HRESULT one = policy->SetDefaultEndpoint(id.c_str(), r);
      if (FAILED(one)) last = one;
    }
  } else {
    last = policy->SetDefaultEndpoint(id.c_str(), role);
  }

  policy->Release();

  if (FAILED(last)) {
    Napi::Error::New(env, "Windows refused the device change (is the device present?)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("getDefaultDevice", Napi::Function::New(env, GetDefaultDevice));
  exports.Set("setDefaultDevice", Napi::Function::New(env, SetDefaultDevice));
  return exports;
}

NODE_API_MODULE(echoaudio, Init)
