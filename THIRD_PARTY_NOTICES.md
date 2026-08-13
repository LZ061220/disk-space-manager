# Third-party notices

磁盘空间管家包含或可与下列第三方组件一同分发。项目自身代码采用 MIT License；第三方组件仍分别遵循其原始许可证。

## llama.cpp / GGML

- Project: llama.cpp
- Upstream release: https://github.com/ggml-org/llama.cpp/releases/tag/b10173
- Bundled build version: `10173 (e9fa0781f)`
- Upstream Windows asset: `llama-b10173-bin-win-cpu-x64.zip`
- License: MIT
- License text: `third_party_licenses/llama.cpp-MIT.txt`

## Qwen2.5-0.5B-Instruct

- Model: Qwen2.5-0.5B-Instruct-GGUF Q5_K_M
- Exact upstream file: https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/qwen2.5-0.5b-instruct-q5_k_m.gguf
- Upstream file commit: `6dd44a1`
- Bundled file: `qwen2.5-0.5b-instruct-q5_k_m.gguf`
- SHA-256: `041474553FCABFC2A2D67903F9D2C2E50BD92528E670DA4F33B5D0CE6E59FD55`
- License: Apache License 2.0
- License text: `third_party_licenses/Apache-2.0.txt`

The SHA-256 above matches the Qwen organization's official GGUF file.

## Electron and JavaScript dependencies

Electron and npm dependencies retain their respective licenses. The packaged application includes Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`; dependency license metadata is recorded in `package-lock.json`.

## Visual assets

The application background is rendered from project-authored CSS/WebGL code and does not redistribute stock background images. The application icon is a project-specific asset distributed with this project.
