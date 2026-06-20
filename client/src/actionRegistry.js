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
];

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
