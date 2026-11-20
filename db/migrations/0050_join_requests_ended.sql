-- bot-link v1 · 0050_join_requests_ended (owner: fix-all lane NOTIFY, blocker 10). GET /app/v1/needs-you lists the
-- person's join requests that ended in the last 30 minutes (appapi/ended.go). Every open dashboard asks for it on each
-- change, so it reads by account through an index instead of over every request ever made.
create index if not exists join_requests_for_account on join_requests (for_account_id, created_at);
