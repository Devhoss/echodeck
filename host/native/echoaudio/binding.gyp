{
  "targets": [
    {
      "target_name": "echoaudio",
      "sources": ["src/echoaudio.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["-lole32.lib", "-loleaut32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            }
          }
        }]
      ]
    }
  ]
}
