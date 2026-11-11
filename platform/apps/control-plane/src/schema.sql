create table if not exists system_config (
  key text primary key,
  value text not null
);

create table if not exists users (
  id uuid primary key,
  username text unique not null,
  display_name text not null,
  password_hash text not null,
  disabled boolean not null,
  language text not null,
  wechat_open_id text unique,
  platform_admin boolean not null
);

create table if not exists sessions (
  id text primary key,
  user_id uuid not null references users (id),
  expires_at timestamptz not null
);

create table if not exists plugins (
  id text primary key,
  name text not null,
  enabled boolean not null,
  updated_at timestamptz not null
);
