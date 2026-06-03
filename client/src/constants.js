// constants.js
export const HOST = `192.168.100.10:9001`;
export const WS_URL = `ws://${HOST}`;
export const API = `http://${HOST}/api`;

// Then in both files replace the hardcoded values:
// js// constants.js
// export const HOST   = `192.168.100.10:9001`;
// export const WS_URL = `ws://${HOST}`;
// export const API    = `http://${HOST}/api`;
// js// App.jsx
// import { WS_URL } from "./constants.js";

// ConfigUI.jsx
// import { API } from "./constants.js";
