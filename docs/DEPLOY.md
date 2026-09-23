# Deploy

The stack is `docker compose up -d --build`: Postgres, the API and the published
frontend (a static build served by nginx under `/flow-editor/`).

- Copy `.env.example` to `.env` and set `FLOW_DB_PASSWORD` and `FLOW_PUBLIC_BASE_URL`.
- Put a reverse proxy with HTTPS in front of port `8020`; the API is reached
  through the frontend's `/api` location.
- For the lineage dataset tabs, write the read-only source password to the file
  `ERP_RO_PASSWORD_HOST_FILE` points at (default `./secrets/probe_ro_pw`).

A fuller, host-independent deployment guide is part of the lineOS roadmap.
