# Microsoft Visual C++ runtime prerequisite

The Windows x64 installer bundles the unmodified, Microsoft-signed Visual C++ v14 x64 Redistributable 14.51.36247.0 as an installation prerequisite. It is extracted only into the installer's temporary plugin directory and is not retained inside the installed application's resource tree. Installation is skipped when an equal or newer x64 v14 runtime is already registered; otherwise the official installer is invoked with `/install /quiet /norestart`. A requested reboot remains the user's decision.

This prerequisite is Microsoft software, not PPT-ai's Apache-2.0 project code. Its Microsoft Software License Terms and redistribution conditions remain applicable. Do not distribute individual runtime DLLs obtained from unofficial download sites. The complete original redistributable retains its embedded Microsoft notices and signature.

The package supplies the CRT, C++ and OpenMP runtime dependencies used by the bundled Whisper and ONNX Runtime binaries. Its immutable Microsoft download and SHA256 are fixed in `scripts/prepare-build.ps1`; preparation records the signer, signature status, size and hash in `app/build/generated/build-inputs.json` without executing the prerequisite.

Primary references:

- https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
- https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
- https://github.com/microsoft/winget-pkgs/blob/master/manifests/m/Microsoft/VCRedist/2015%2B/x64/14.51.36247.0/Microsoft.VCRedist.2015%2B.x64.installer.yaml
