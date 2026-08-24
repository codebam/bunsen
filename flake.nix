{
  description = "Bunsen — a web browser with Bun as the JavaScript backend";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nativeDeps = with pkgs; [ gtk4 webkitgtk_6_0 glib glib-networking ];
      in {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [ pkg-config rustc cargo rustfmt clippy bun ];
          buildInputs = nativeDeps;

          # WebKitGTK needs its TLS backend and web process helpers on the search path.
          shellHook = ''
            export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            export BUNSEN_BACKEND_PATH="$PWD/packages/render-webkit/target/debug/libbunsen_render_webkit.so"
          '';
        };
      });
}
