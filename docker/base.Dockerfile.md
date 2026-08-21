The three Dockerfiles in this directory share the same shape:

base -> node:22-alpine + pnpm + workspace manifests + full install
build -> compiles packages then the app
development -> runs the app in watch mode against mounted sources
production -> minimal runtime image with only the built output

They are intentionally separate files (rather than one multi-app Dockerfile)
so each service can be built and cached independently in CI.
