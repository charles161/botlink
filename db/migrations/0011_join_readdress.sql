-- bot-link v1 · 0011_join_readdress (owner: server). Security review item 11: a join request goes to whoever made the
-- chat invite it used. A chat that used another person's invite (Charles's link pasted into Victor's chat) put its card
-- on Charles's dashboard, and one click made Victor's chat "Charles's chat". Self-heal: when a different person of the
-- same room opens the request's approve link, they may take the request over (once). readdressed_from keeps who it
-- was addressed to first. Additive only: the previous binary keeps working on this schema until it restarts.
alter table join_requests add column if not exists readdressed_from uuid references accounts (id);
