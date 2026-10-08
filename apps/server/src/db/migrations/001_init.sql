-- Plakat initial schema.
CREATE TABLE projects (
  id                   text PRIMARY KEY,
  title                text NOT NULL,
  document             jsonb NOT NULL,
  schema_version       integer NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  size                 jsonb NOT NULL,
  page_count           integer NOT NULL,
  thumbnail            bytea,
  thumbnail_updated_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_updated_at_idx ON projects (updated_at DESC);

CREATE TABLE templates (
  id                   text PRIMARY KEY,
  title                text NOT NULL,
  category             text,
  document             jsonb NOT NULL,
  schema_version       integer NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  built_in             boolean NOT NULL DEFAULT false,
  content_hash         text,
  search_text          text NOT NULL DEFAULT '',
  size                 jsonb NOT NULL,
  page_count           integer NOT NULL,
  slot_count           integer NOT NULL,
  thumbnail            bytea,
  thumbnail_updated_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_category_idx ON templates (category);

CREATE TABLE brand_kits (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  kit        jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE uploads (
  sha256      text PRIMARY KEY,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  byte_size   integer NOT NULL,
  attribution jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
