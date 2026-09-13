FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS guest
RUN apk add --no-cache linux-virt postgresql17 postgresql17-client curl ca-certificates \
    && curl -fsSL -o /tmp/inngest.tar.gz https://github.com/inngest/inngest/releases/download/v1.44.0/inngest_1.44.0_linux_arm64.tar.gz \
    && echo "9c28bb9438e276f70ddfe0914cc34a960312eef37c88577b4b21c64b12dd0a2b  /tmp/inngest.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/inngest.tar.gz -C /usr/local/bin inngest \
    && rm /tmp/inngest.tar.gz \
    && /usr/local/bin/inngest version \
    && mkdir -p /work /proc /sys /dev /run /data \
    && rm -rf /lib/modules /boot/initramfs-* /usr/local/lib/node_modules /opt/yarn* /root/.npm
COPY init /init
RUN chmod +x /init

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
RUN apk add --no-cache qemu-system-aarch64 cpio gzip
COPY --from=guest / /guest/
COPY launch /usr/local/bin/launch
RUN chmod +x /usr/local/bin/launch
ENTRYPOINT ["/usr/local/bin/launch"]
