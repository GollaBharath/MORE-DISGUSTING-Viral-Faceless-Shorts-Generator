FROM ghcr.io/coqui-ai/tts-cpu

EXPOSE 5002

COPY start_xtts_server.sh /start_xtts_server.sh
RUN chmod +x /start_xtts_server.sh

ENTRYPOINT ["/start_xtts_server.sh"]