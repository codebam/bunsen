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

        # Runtime graphics/network stack. Linked dynamically — see LICENSING.md
        # for why that matters with LGPL dependencies.
        nativeDeps = with pkgs; [
          # WebKitGTK backend
          gtk4 webkitgtk_6_0 glib glib-networking
          # Blitz backend: wgpu needs a Vulkan loader, Parley needs fontconfig,
          # and reqwest's default TLS wants OpenSSL.
          vulkan-loader libxkbcommon fontconfig openssl
          wayland libGL
        ];

        # Both backends come out of one workspace build: they share the
        # protocol crate, and building them together is what keeps them in
        # step.
        # Only the Rust half of the tree. With `src = ./.` a one-line edit to
        # the TypeScript shell changed the source hash and rebuilt Stylo,
        # which is ten minutes for nothing.
        rustSource = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./Cargo.toml
            ./Cargo.lock
            ./packages/protocol
            ./packages/render-webkit
            ./packages/render-blitz
          ];
        };

        renderBackends = pkgs.rustPlatform.buildRustPackage {
          pname = "bunsen-render-backends";
          version = "0.1.0";
          src = rustSource;
          cargoLock.lockFile = ./Cargo.lock;

          # Stylo generates its property tables at build time with a Mako
          # template pass, so the sandbox needs a Python with mako on it —
          # a dev shell inherits one from the user's environment and hides
          # this, which is exactly how it got missed.
          nativeBuildInputs = [
            pkgs.pkg-config
            (pkgs.python3.withPackages (ps: [ ps.mako ]))
          ];
          buildInputs = nativeDeps;

          # buildRustPackage installs binaries but not cdylibs, and the FFI
          # transport needs the cdylib.
          postInstall = ''
            mkdir -p $out/lib
            find target -name 'libbunsen_render_webkit.so' -exec cp {} $out/lib/ \;
          '';

          meta = with pkgs.lib; {
            description = "Bunsen render backends (WebKitGTK and Blitz)";
            license = with licenses; [ mit asl20 ];
            platforms = platforms.linux;
          };
        };

        bunsen = pkgs.stdenv.mkDerivation {
          pname = "bunsen";
          version = "0.1.0";
          src = ./packages/shell;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/bunsen
            cp -r src $out/share/bunsen/

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/bunsen \
              --add-flags "run $out/share/bunsen/src/main.ts" \
              --set BUNSEN_BACKEND_PATH ${renderBackends}/lib/libbunsen_render_webkit.so \
              --set BUNSEN_HOST_PATH ${renderBackends}/bin/bunsen-render-host \
              --set BUNSEN_BLITZ_HOST_PATH ${renderBackends}/bin/bunsen-render-blitz-host \
              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath nativeDeps}" \
              --set GIO_MODULE_DIR ${pkgs.glib-networking}/lib/gio/modules \
              --set GIO_EXTRA_MODULES ${pkgs.glib-networking}/lib/gio/modules \
              --set WEBKIT_DISABLE_DMABUF_RENDERER 1 \
              --prefix XDG_DATA_DIRS : "${pkgs.gtk4}/share:${pkgs.gsettings-desktop-schemas}/share:${pkgs.shared-mime-info}/share" \
              --prefix GSETTINGS_SCHEMA_DIR : "${pkgs.gtk4}/share/gsettings-schemas/${pkgs.gtk4.name}/glib-2.0/schemas"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "A web browser with Bun as the JavaScript backend";
            license = with licenses; [ mit asl20 ];
            platforms = platforms.linux;
            mainProgram = "bunsen";
          };
        };
      in {
        packages = {
          inherit bunsen renderBackends;
          default = bunsen;
        };

        apps.default = {
          type = "app";
          program = "${bunsen}/bin/bunsen";
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            pkg-config rustc cargo rustfmt clippy bun
            # Same Stylo build-time dependency as the package. Pinned here too
            # so the dev shell does not quietly rely on the host's Python.
            (python3.withPackages (ps: [ ps.mako ]))
          ];
          buildInputs = nativeDeps;

          # WebKitGTK needs its TLS backend on the module path, or every https
          # load fails with a bare "TLS support unavailable".
          shellHook = ''
            export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            export BUNSEN_BACKEND_PATH="$PWD/target/debug/libbunsen_render_webkit.so"
            export BUNSEN_HOST_PATH="$PWD/target/debug/bunsen-render-host"
            export BUNSEN_BLITZ_HOST_PATH="$PWD/target/debug/bunsen-render-blitz-host"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath nativeDeps}:$LD_LIBRARY_PATH"
          '';
        };
      });
}
