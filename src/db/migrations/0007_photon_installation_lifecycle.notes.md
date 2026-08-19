# Migration 0007 compatibility and rollback

## Compatibility

- Apply after the integration branch has reconciled migrations `0005` and
  `0006`. This leaf branch intentionally does not edit Drizzle metadata.
- Existing deployments receive owner revision `1`. New deployments should
  create revision `0`, then increment it in the same transaction that writes
  the first owner phone binding.
- The lifecycle tables are additive. Existing `PhotonSetupService` and the
  disk-backed `PhotonCredentialsStore` continue to work until production
  composition explicitly switches to the durable service.
- One installation is allowed per deployment. Project IDs and all secret
  ciphertexts are nullable during provisioning but required by the connected
  state check.
- The owner-binding transaction must bump `owner_binding_revisions` and
  invalidate the installation operation before it commits a changed phone
  binding. The exact integration hook is documented in
  `docs/integration/03-photon-installation-lifecycle.md`.

## Rollback

Prefer rolling the application back while leaving these additive tables in
place. The prior application does not read them. If a schema rollback is
mandatory, stop setup and runtime processes, retain a protected credential
backup, and run:

```sql
DROP TABLE IF EXISTS photon_installations;
DROP TABLE IF EXISTS owner_binding_revisions;
DROP TYPE IF EXISTS photon_installation_step;
DROP TYPE IF EXISTS photon_installation_state;
```

Dropping `photon_installations` permanently deletes the provisioning journal
and its encrypted Photon management token, Spectrum secret, assigned number,
and pending device authorization. It does not revoke or delete the remote
Photon project. A later install must conservatively import a still-valid legacy
credential or run a new explicit setup/repair operation.
