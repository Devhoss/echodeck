export const ACTION_REGISTRY = [
  {
    id: "keystroke",
    name: "Hotkey",
    icon: "keyboard",
    category: "System",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No keys set",
    fields: [
      {
        type: "text",
        key: "action_value",
        label: "Key combo",
        placeholder: "ctrl+s",
      },
    ],
  },
  {
    id: "type",
    name: "Type Text",
    icon: "type",
    category: "System",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No text set",
    fields: [
      {
        type: "text",
        key: "action_value",
        label: "Text",
        placeholder: "Hello world",
      },
    ],
  },
  {
    id: "shell",
    name: "Shell Command",
    icon: "terminal",
    category: "System",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No command set",
    fields: [
      {
        type: "text",
        key: "action_value",
        label: "Command",
        placeholder: "cmd.exe",
      },
    ],
  },
  {
    id: "url",
    name: "Open URL",
    icon: "external-link",
    category: "System",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No URL set",
    fields: [
      {
        type: "text",
        key: "action_value",
        label: "URL",
        placeholder: "https://example.com",
      },
    ],
  },
  {
    id: "launch",
    name: "Launch App",
    icon: "rocket",
    category: "System",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No app selected",
    fields: [
      {
        type: "file",
        key: "action_value",
        label: "Application path",
        placeholder: "C:\\Path\\To\\App.exe",
      },
    ],
  },
  // {
  //   id: "delay",
  //   name: "Delay",
  //   icon: "timer",
  //   category: "System",
  //   defaults: { action_value: "1000" },
  //   summary: (action) => `${parseInt(action.action_value) || 1000}ms`,
  //   fields: [
  //     {
  //       type: "number",
  //       key: "action_value",
  //       label: "Duration",
  //       min: 0,
  //       step: 100,
  //       fallback: 1000,
  //       suffix: "ms",
  //     },
  //   ],
  // },
  {
    id: "volume_up",
    name: "Volume Up",
    icon: "volume-2",
    category: "Audio",
    defaults: { action_value: "5" },
    summary: (action) => `Step ${parseInt(action.action_value) || 5}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
        suffix: "%",
        note: "Hold the button to adjust continuously.",
      },
    ],
  },
  {
    id: "volume_down",
    name: "Volume Down",
    icon: "volume-1",
    category: "Audio",
    defaults: { action_value: "5" },
    summary: (action) => `Step ${parseInt(action.action_value) || 5}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
        suffix: "%",
        note: "Hold the button to adjust continuously.",
      },
    ],
  },
  {
    id: "volume_set",
    name: "Set Volume",
    icon: "sliders-horizontal",
    category: "Audio",
    defaults: { action_value: "50" },
    summary: (action) => `${parseInt(action.action_value) || 50}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Target volume",
        min: 0,
        max: 100,
        fallback: 50,
        suffix: "%",
      },
    ],
  },
  {
    id: "volume_mute",
    name: "Mute Toggle",
    icon: "volume-x",
    category: "Audio",
    defaults: { action_value: "" },
    summary: () => "Toggles mute",
    fields: [{ type: "info", text: "Toggles mute on/off. No value needed." }],
  },
  {
    id: "audio_switch_device",
    name: "Switch Audio Output",
    icon: "audio-lines",
    category: "Audio",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No device selected",
    fields: [
      {
        type: "audio_device",
        key: "action_value",
        label: "Output device",
        placeholder: "e.g. Speakers (Realtek)",
      },
    ],
  },
  {
    id: "mic_mute",
    name: "Mute Microphone",
    icon: "mic-off",
    category: "Microphone",
    defaults: { action_value: "" },
    summary: () => "Toggles mic mute",
    fields: [
      { type: "info", text: "Toggles the microphone on/off. No value needed." },
    ],
  },
  {
    id: "mic_volume_up",
    name: "Mic Volume Up",
    icon: "mic",
    category: "Microphone",
    defaults: { action_value: "5" },
    summary: (action) => `Step ${parseInt(action.action_value) || 5}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
        suffix: "%",
        note: "Hold the button to adjust continuously.",
      },
    ],
  },
  {
    id: "mic_volume_down",
    name: "Mic Volume Down",
    icon: "mic",
    category: "Microphone",
    defaults: { action_value: "5" },
    summary: (action) => `Step ${parseInt(action.action_value) || 5}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
        suffix: "%",
        note: "Hold the button to adjust continuously.",
      },
    ],
  },
  {
    id: "mic_volume_set",
    name: "Set Mic Volume",
    icon: "sliders-horizontal",
    category: "Microphone",
    defaults: { action_value: "80" },
    summary: (action) => `${parseInt(action.action_value) || 80}%`,
    fields: [
      {
        type: "range",
        key: "action_value",
        label: "Target level",
        min: 0,
        max: 100,
        fallback: 80,
        suffix: "%",
      },
    ],
  },
  {
    id: "mic_switch_device",
    name: "Switch Microphone",
    icon: "audio-lines",
    category: "Microphone",
    defaults: { action_value: "" },
    summary: (action) => action.action_value || "No device selected",
    fields: [
      {
        type: "input_device",
        key: "action_value",
        label: "Input device",
        placeholder: "e.g. Microphone (Headset)",
      },
    ],
  },
  {
    id: "app_mute",
    name: "Mute App",
    icon: "volume-x",
    category: "App Audio",
    defaults: { action_value: "" },
    summary: (action) =>
      unpackAppValue(action.action_value).app || "No app selected",
    fields: [
      {
        type: "app_picker",
        key: "action_value",
        label: "Application",
      },
    ],
  },
  {
    id: "app_volume_set",
    name: "Set App Volume",
    icon: "sliders-horizontal",
    category: "App Audio",
    defaults: { action_value: "|50" },
    summary: (action) => {
      const { app, amount } = unpackAppValue(action.action_value);
      return app ? `${app} → ${parseInt(amount) || 0}%` : "No app selected";
    },
    fields: [
      {
        type: "app_level",
        key: "action_value",
        label: "Application",
        amountLabel: "Target volume",
        min: 0,
        max: 100,
        fallback: 50,
      },
    ],
  },
  {
    id: "app_volume_up",
    name: "App Volume Up",
    icon: "volume-2",
    category: "App Audio",
    defaults: { action_value: "|5" },
    summary: (action) => {
      const { app, amount } = unpackAppValue(action.action_value);
      return app ? `${app} +${parseInt(amount) || 5}%` : "No app selected";
    },
    fields: [
      {
        type: "app_level",
        key: "action_value",
        label: "Application",
        amountLabel: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
      },
    ],
  },
  {
    id: "app_volume_down",
    name: "App Volume Down",
    icon: "volume-1",
    category: "App Audio",
    defaults: { action_value: "|5" },
    summary: (action) => {
      const { app, amount } = unpackAppValue(action.action_value);
      return app ? `${app} −${parseInt(amount) || 5}%` : "No app selected";
    },
    fields: [
      {
        type: "app_level",
        key: "action_value",
        label: "Application",
        amountLabel: "Step size",
        min: 1,
        max: 20,
        fallback: 5,
      },
    ],
  },
];

// Volume keys show a live level on the face and repeat while held. Both the
// phone and the desktop need to know which action ids behave that way, and the
// list has to stay in one place now that microphone keys do it too.
export const SPEAKER_LEVEL_ACTIONS = new Set([
  "volume_up",
  "volume_down",
  "volume_set",
  "volume_mute",
]);

export const MIC_LEVEL_ACTIONS = new Set([
  "mic_volume_up",
  "mic_volume_down",
  "mic_volume_set",
  "mic_mute",
]);

export const HOLD_REPEAT_ACTIONS = new Set([
  "volume_up",
  "volume_down",
  "mic_volume_up",
  "mic_volume_down",
]);

// Per-app actions need two inputs — which application, and how much — but an
// action only ever carries one `action_value`, because actions also live inside
// multi-action stacks as plain {action_type, action_value} objects with no
// columns of their own. So both are packed into one string. "|" is safe as the
// separator: Windows forbids it in filenames, so no process name can contain one.
export function packAppValue(app, amount) {
  return amount === undefined || amount === null || amount === ""
    ? String(app ?? "")
    : `${app ?? ""}|${amount}`;
}

export function unpackAppValue(value) {
  const [app = "", amount = ""] = String(value ?? "").split("|");
  return { app, amount };
}

export function levelTargetFor(actionType) {
  if (MIC_LEVEL_ACTIONS.has(actionType)) return "mic";
  if (SPEAKER_LEVEL_ACTIONS.has(actionType)) return "speaker";
  return null;
}

export const ACTION_BY_ID = Object.fromEntries(
  ACTION_REGISTRY.map((action) => [action.id, action]),
);

export const ACTION_CATEGORIES = [
  ...new Set(ACTION_REGISTRY.map((action) => action.category)),
].map((category) => ({
  label: category,
  actions: ACTION_REGISTRY.filter((action) => action.category === category),
}));

export function actionTypeLabel(type) {
  return ACTION_BY_ID[type]?.name || type || "Action";
}

export function applyActionTypeDefaults(action, actionType) {
  const meta = ACTION_BY_ID[actionType] || ACTION_BY_ID.keystroke;
  return {
    ...action,
    action_type: actionType,
    ...(meta.defaults || {}),
  };
}
