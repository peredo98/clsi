#!/bin/sh

docker --version >&2

DOCKER_GROUP=$(stat -c '%g' /var/run/docker.sock)
groupadd --non-unique --gid ${DOCKER_GROUP} dockeronhost
usermod -aG dockeronhost node

mkdir -p /app/test/acceptance/fixtures/tmp/
chown -R node:node /app/test/acceptance/fixtures

./bin/install_texlive_gce.sh
exec runuser -u node -- "$@"
