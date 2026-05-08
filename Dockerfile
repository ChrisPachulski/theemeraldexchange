FROM nginx:alpine

# Drop the default config and replace with ours (template; envsubst at boot).
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx/default.conf /etc/nginx/templates/default.conf.template

# The static build output produced by `npm run build`.
COPY dist /usr/share/nginx/html

# nginx:alpine's entrypoint runs envsubst over /etc/nginx/templates/*.template
# automatically, substituting ${VAR} references with the container's env vars.
# Required at runtime: SONARR_API_KEY, RADARR_API_KEY, SAB_API_KEY.

EXPOSE 80
