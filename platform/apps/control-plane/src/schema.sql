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

create table if not exists wechat_states (
  state text primary key,
  expires_at timestamptz not null
);

create table if not exists container_groups (
  id uuid primary key,
  code text unique not null
);

create table if not exists projects (
  id uuid primary key,
  name text not null,
  code text unique not null,
  container_group_id uuid not null references container_groups (id) on delete cascade,
  created_by uuid not null references users (id) on delete cascade
);

create table if not exists platform_permissions (
  user_id uuid not null references users (id) on delete cascade,
  permission text not null,
  primary key (user_id, permission)
);

create table if not exists project_members (
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  project_admin boolean not null,
  primary key (project_id, user_id)
);

create table if not exists project_roles (
  project_id uuid not null references projects (id) on delete cascade,
  name text not null,
  primary key (project_id, name)
);

create table if not exists project_role_members (
  project_id uuid not null references projects (id) on delete cascade,
  role_name text not null,
  username text not null,
  primary key (project_id, role_name, username)
);

create table if not exists draft_menus (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  code text not null,
  name text not null,
  parent_code text,
  sort integer not null,
  unique (project_id, code)
);

create table if not exists draft_grants (
  project_id uuid not null references projects (id) on delete cascade,
  principal_type text not null,
  principal_name text not null,
  menu_code text not null,
  action text not null,
  primary key (project_id, principal_type, principal_name, menu_code, action)
);

create table if not exists requirement_sessions (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade
);

create table if not exists requirement_messages (
  id uuid primary key,
  session_id uuid not null references requirement_sessions (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null
);

create table if not exists draft_records (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null,
  body jsonb not null
);

create table if not exists openspec_changes (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  added jsonb not null,
  modified jsonb not null,
  removed jsonb not null,
  confirmed_at timestamptz not null
);

create table if not exists project_designs (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  revision text not null,
  body jsonb not null,
  source_revision text not null,
  files jsonb not null,
  created_at timestamptz not null
);

create table if not exists release_candidates (
  id uuid primary key,
  project_id uuid not null references projects (id) on delete cascade,
  source_revision text not null,
  image_digest text not null,
  created_at timestamptz not null
);

create table if not exists nodes (
  id uuid primary key,
  name text unique not null,
  zone text not null
);

alter table nodes add column if not exists token_hash text not null default '';
alter table nodes add column if not exists install_token_hash text not null default '';

create table if not exists node_reports (
  node_name text primary key references nodes (name) on delete cascade,
  reported_at timestamptz not null,
  projects jsonb not null
);

create table if not exists desired_states (
  project_id uuid primary key references projects (id) on delete cascade,
  image_digest text not null,
  target_nodes text not null,
  replicas integer not null
);

create table if not exists published_menus (
  project_id uuid not null references projects (id) on delete cascade,
  code text not null,
  name text not null,
  primary key (project_id, code)
);

create table if not exists published_grants (
  project_id uuid not null references projects (id) on delete cascade,
  principal_type text not null,
  principal_name text not null,
  menu_code text not null,
  action text not null,
  primary key (project_id, principal_type, principal_name, menu_code, action)
);

create table if not exists published_versions (
  project_id uuid primary key references projects (id) on delete cascade,
  image_digest text not null
);

create table if not exists portal_notifications (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  body text not null,
  created_at timestamptz not null
);

