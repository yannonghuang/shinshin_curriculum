# Production image: build the static CRA bundle, then serve it via nginx
# (this app is a plain CRA build, not a Node SSR server, so nginx replaces
# the dev server entirely at runtime).
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# Build identity (passed by scripts/deploy-aliyun.sh), baked into the bundle
# via CRA's REACT_APP_* convention -- see build-info.component.js.
ARG BUILD_TAG=""
ARG BUILD_COMMIT=""
ARG BUILD_COMMIT_TIME=""
ARG BUILD_TIME=""
ENV REACT_APP_BUILD_TAG=$BUILD_TAG REACT_APP_BUILD_COMMIT=$BUILD_COMMIT REACT_APP_BUILD_COMMIT_TIME=$BUILD_COMMIT_TIME REACT_APP_BUILD_TIME=$BUILD_TIME
# react-scripts 3.4.0 (webpack 4) needs the legacy OpenSSL provider on Node >=17.
RUN NODE_OPTIONS=--openssl-legacy-provider npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
