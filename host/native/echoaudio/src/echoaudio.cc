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
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <psapi.h>
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
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
// Per-application volume
//
// Windows tracks volume per audio *session*, not per application, and one
// program often owns several — a browser opens one per tab group, and some
// apps leave expired sessions behind after playback stops. So a session is
// identified here by its owning process name, and every write applies to all
// of that process's sessions at once. That is what "mute Spotify" means, and
// it is also what survives the app restarting under a new pid.
// ---------------------------------------------------------------------------

namespace {

std::string ProcessNameForPid(DWORD pid) {
  if (pid == 0) return {};
  // LIMITED_INFORMATION is enough for the image name and, unlike QUERY_INFORMATION,
  // is granted for processes running at a different integrity level.
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return {};

  wchar_t buffer[MAX_PATH] = {0};
  DWORD size = MAX_PATH;
  std::string name;
  if (QueryFullProcessImageNameW(proc, 0, buffer, &size)) {
    std::wstring full(buffer, size);
    const size_t slash = full.find_last_of(L"\\/");
    name = ToUtf8((slash == std::wstring::npos ? full : full.substr(slash + 1)).c_str());
  }
  CloseHandle(proc);
  return name;
}

std::string LowerCopy(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(::tolower(c)); });
  return s;
}

// Walks every session on the default render endpoint, calling `visit` with the
// session's control interface, its volume interface, and its process name.
// Returns false only if the enumerator itself could not be obtained.
template <typename Fn>
bool ForEachSession(Fn visit) {
  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(&enumerator)))) {
    return false;
  }

  IMMDevice* device = nullptr;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device)) || !device) {
    enumerator->Release();
    return false;
  }

  IAudioSessionManager2* manager = nullptr;
  if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(&manager))) ||
      !manager) {
    device->Release();
    enumerator->Release();
    return false;
  }

  IAudioSessionEnumerator* sessions = nullptr;
  if (FAILED(manager->GetSessionEnumerator(&sessions)) || !sessions) {
    manager->Release();
    device->Release();
    enumerator->Release();
    return false;
  }

  int count = 0;
  sessions->GetCount(&count);

  for (int i = 0; i < count; i++) {
    IAudioSessionControl* control = nullptr;
    if (FAILED(sessions->GetSession(i, &control)) || !control) continue;

    IAudioSessionControl2* control2 = nullptr;
    ISimpleAudioVolume* volume = nullptr;
    if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioSessionControl2),
                                          reinterpret_cast<void**>(&control2))) &&
        SUCCEEDED(control->QueryInterface(__uuidof(ISimpleAudioVolume),
                                          reinterpret_cast<void**>(&volume)))) {
      DWORD pid = 0;
      control2->GetProcessId(&pid);
      const bool isSystem = control2->IsSystemSoundsSession() == S_OK;
      std::string procName = isSystem ? "System Sounds" : ProcessNameForPid(pid);
      visit(control2, volume, pid, procName, isSystem);
    }

    if (volume) volume->Release();
    if (control2) control2->Release();
    control->Release();
  }

  sessions->Release();
  manager->Release();
  device->Release();
  enumerator->Release();
  return true;
}

}  // namespace

// listSessions() -> [{ pid, processName, displayName, volume, muted, isSystem, active }]
Napi::Value ListSessions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComScope com;

  Napi::Array result = Napi::Array::New(env);
  uint32_t written = 0;

  const bool ok = ForEachSession([&](IAudioSessionControl2* control, ISimpleAudioVolume* volume,
                                     DWORD pid, const std::string& procName, bool isSystem) {
    // A session whose process has gone leaves no name behind and cannot be
    // acted on, so it is not worth showing.
    if (procName.empty()) return;

    float level = 0.0f;
    volume->GetMasterVolume(&level);
    BOOL muted = FALSE;
    volume->GetMute(&muted);

    AudioSessionState state = AudioSessionStateInactive;
    control->GetState(&state);

    LPWSTR display = nullptr;
    std::string displayName;
    if (SUCCEEDED(control->GetDisplayName(&display)) && display) {
      displayName = ToUtf8(display);
      CoTaskMemFree(display);
    }
    // Most apps never set a display name, and Windows' own sessions set an
    // unexpanded resource reference ("@%SystemRoot%\\System32\\AudioSrv.Dll,-202").
    // Neither is showable, so fall back to the process name.
    if (displayName.empty() || displayName[0] == '@') displayName = procName;

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("pid", Napi::Number::New(env, static_cast<double>(pid)));
    entry.Set("processName", Napi::String::New(env, procName));
    entry.Set("displayName", Napi::String::New(env, displayName));
    entry.Set("volume", Napi::Number::New(env, static_cast<int>(level * 100.0f + 0.5f)));
    entry.Set("muted", Napi::Boolean::New(env, muted != FALSE));
    entry.Set("isSystem", Napi::Boolean::New(env, isSystem));
    entry.Set("active", Napi::Boolean::New(env, state == AudioSessionStateActive));
    result.Set(written++, entry);
  });

  if (!ok) {
    Napi::Error::New(env, "Could not enumerate audio sessions")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return result;
}

// setSessionVolume(processName, 0..100) -> number of sessions changed
Napi::Value SetSessionVolume(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "setSessionVolume(processName, level) requires a name and a level")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const std::string wanted = LowerCopy(info[0].As<Napi::String>().Utf8Value());
  const int level = (std::max)(0, (std::min)(100, info[1].As<Napi::Number>().Int32Value()));
  const float scalar = static_cast<float>(level) / 100.0f;

  ComScope com;
  int changed = 0;
  ForEachSession([&](IAudioSessionControl2*, ISimpleAudioVolume* volume, DWORD,
                     const std::string& procName, bool) {
    if (LowerCopy(procName) != wanted) return;
    if (SUCCEEDED(volume->SetMasterVolume(scalar, nullptr))) changed++;
  });

  return Napi::Number::New(env, changed);
}

// setSessionMute(processName, muted | "toggle") -> number of sessions changed
Napi::Value SetSessionMute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "setSessionMute(processName, muted) requires a process name")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const std::string wanted = LowerCopy(info[0].As<Napi::String>().Utf8Value());
  const bool toggle = info.Length() < 2 || !info[1].IsBoolean();
  const BOOL target = toggle ? FALSE : (info[1].As<Napi::Boolean>().Value() ? TRUE : FALSE);

  ComScope com;
  int changed = 0;
  // With several sessions for one process, the first one's state decides the
  // toggle for all of them — otherwise a half-muted app would flip into a
  // different half-muted state instead of simply muting.
  bool decided = false;
  BOOL resolved = FALSE;

  ForEachSession([&](IAudioSessionControl2*, ISimpleAudioVolume* volume, DWORD,
                     const std::string& procName, bool) {
    if (LowerCopy(procName) != wanted) return;

    if (!decided) {
      if (toggle) {
        BOOL current = FALSE;
        volume->GetMute(&current);
        resolved = current ? FALSE : TRUE;
      } else {
        resolved = target;
      }
      decided = true;
    }

    if (SUCCEEDED(volume->SetMute(resolved, nullptr))) changed++;
  });

  return Napi::Number::New(env, changed);
}

// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("getDefaultDevice", Napi::Function::New(env, GetDefaultDevice));
  exports.Set("setDefaultDevice", Napi::Function::New(env, SetDefaultDevice));
  exports.Set("listSessions", Napi::Function::New(env, ListSessions));
  exports.Set("setSessionVolume", Napi::Function::New(env, SetSessionVolume));
  exports.Set("setSessionMute", Napi::Function::New(env, SetSessionMute));
  return exports;
}

NODE_API_MODULE(echoaudio, Init)
