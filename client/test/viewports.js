// width x height CSS px. Phone portrait/landscape, foldable, tablet, desktop.
export const VIEWPORTS = [
  { name: "narrow-phone-portrait",   w: 320,  h: 653 },
  { name: "phone-portrait",          w: 360,  h: 800 },
  { name: "phone-portrait-large",    w: 390,  h: 844 },
  { name: "phone-portrait-xl",       w: 430,  h: 932 },
  { name: "compact-phone-landscape", w: 653,  h: 320 },
  { name: "phone-landscape",         w: 800,  h: 360 },
  { name: "phone-landscape-large",   w: 932,  h: 430 },
  { name: "foldable-expanded",       w: 673,  h: 841 },
  { name: "tablet-portrait",         w: 800,  h: 1280 },
  { name: "tablet-landscape",        w: 1024, h: 768 },
  { name: "small-tablet-portrait",   w: 600,  h: 960 },
  { name: "desktop-compact",         w: 900,  h: 600 },  // Electron minHeight/width pair
  { name: "desktop-window",          w: 1280, h: 800 },
  { name: "desktop-wide",            w: 1600, h: 900 },
];
