-- Trash retention timestamps must be explicit UTC ISO-8601. Earlier migrations and
-- policy updates used SQLite datetime(), which emitted a timezone-less value and
-- caused browsers in non-UTC timezones to shift the displayed retention deadline.
UPDATE assets
SET purge_at = strftime('%Y-%m-%dT%H:%M:%fZ', purge_at)
WHERE purge_at IS NOT NULL
  AND purge_at NOT LIKE '%Z';
