-- Run against a disposable Supabase test database after the migration, as postgres.
-- Entire fixture rolls back; these are not real Auth sessions or hosted account tests.
begin;
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls-fixture-a@example.invalid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rls-fixture-b@example.invalid');
insert into public.calibration_tenants values ('rls-tenant-a'), ('rls-tenant-b');
insert into public.calibration_memberships values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls-tenant-a'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rls-tenant-b');
insert into public.calibration_workspaces values ('rls-workspace-a', 'rls-tenant-a'), ('rls-workspace-b', 'rls-tenant-b');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.calibration_workspaces) = 1, 'Alice sees one workspace';
  assert (select id from public.calibration_workspaces) = 'rls-workspace-a', 'Alice cannot see Bob';
  assert (select count(*) from public.calibration_tenants) = 1, 'Tenant RLS';
  assert (select count(*) from public.calibration_memberships) = 1, 'Membership RLS';
  begin
    insert into public.calibration_memberships values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls-tenant-b');
    raise exception 'Client granted its own membership';
  exception when insufficient_privilege then null; end;
  begin
    update public.calibration_workspaces set tenant_id = 'rls-tenant-b' where id = 'rls-workspace-a';
    raise exception 'Client reassigned its workspace';
  exception when insufficient_privilege then null; end;
end $$;

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.calibration_workspaces) = 1, 'Bob sees one workspace';
  assert (select id from public.calibration_workspaces) = 'rls-workspace-b', 'Bob cannot see Alice';
end $$;

reset role;
delete from public.calibration_memberships where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.calibration_workspaces) = 0, 'Revocation applies to an existing JWT';
end $$;

set local role anon;
set local request.jwt.claims = '{}';
do $$ begin
  begin
    perform id from public.calibration_workspaces;
    raise exception 'Anonymous workspace read succeeded';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
