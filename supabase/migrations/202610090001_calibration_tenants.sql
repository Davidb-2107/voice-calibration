-- Hosted Auth owns users; the operator provisions memberships and private workspaces.
begin;

create table public.calibration_tenants (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);
create table public.calibration_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id text not null references public.calibration_tenants(id) on delete cascade
);
create table public.calibration_workspaces (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  tenant_id text not null unique references public.calibration_tenants(id) on delete cascade
);

alter table public.calibration_tenants enable row level security;
alter table public.calibration_memberships enable row level security;
alter table public.calibration_workspaces enable row level security;

revoke all on public.calibration_tenants, public.calibration_memberships,
  public.calibration_workspaces from public, anon, authenticated;
grant select on public.calibration_tenants, public.calibration_memberships,
  public.calibration_workspaces to authenticated;
grant all on public.calibration_tenants, public.calibration_memberships,
  public.calibration_workspaces to service_role;

create policy own_membership on public.calibration_memberships for select to authenticated
  using ((select auth.uid()) = user_id);
create policy member_tenant on public.calibration_tenants for select to authenticated
  using (id in (select tenant_id from public.calibration_memberships where user_id = (select auth.uid())));
create policy member_workspace on public.calibration_workspaces for select to authenticated
  using (tenant_id in (select tenant_id from public.calibration_memberships where user_id = (select auth.uid())));

commit;
