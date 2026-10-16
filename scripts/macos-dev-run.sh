#!/bin/sh
# Cargo runner on macOS (see .cargo/config.toml). A debug build is ad-hoc signed by the linker
# with a signature that changes on every rebuild, so the Keychain's "Always Allow" never sticks
# and macOS asks for the login password at every launch. Signing the app binary with a stable
# identity (a local Apple Development or Developer ID certificate) keeps that permission.
# Without such a certificate it just runs the binary. HOSTEALO_SIGN_IDENTITY picks another one.
bin="$1"
if [ "$(basename "$bin")" = "hostealo-terminal" ]; then
  identity="${HOSTEALO_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk '/"(Apple Development|Developer ID Application):/ { print $2; exit }')}"
  if [ -n "$identity" ]; then
    codesign --force --sign "$identity" --identifier es.hostealo.terminal "$bin" >/dev/null 2>&1 ||
      echo "macos-dev-run: could not sign the debug build; the Keychain will ask again" >&2
  fi
fi
exec "$@"
