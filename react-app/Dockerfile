# Production image: build the static CRA bundle, then serve it via nginx
# (this app is a plain CRA build, not a Node SSR server, so nginx replaces
# the dev server entirely at runtime).
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# react-scripts 3.4.0 (webpack 4) needs the legacy OpenSSL provider on Node >=17.
RUN NODE_OPTIONS=--openssl-legacy-provider npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
