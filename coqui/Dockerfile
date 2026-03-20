FROM ghcr.io/coqui-ai/tts-cpu

EXPOSE 5002

COPY start_xtts_server.sh /start_xtts_server.sh
COPY wsgi.py /wsgi.py
RUN chmod +x /start_xtts_server.sh /wsgi.py

ENTRYPOINT ["/start_xtts_server.sh"]