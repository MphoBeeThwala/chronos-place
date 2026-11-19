output "deny_non_af_south_1_policy_id" {
  description = "ID of the data-residency SCP."
  value       = aws_organizations_policy.deny_non_af_south_1.id
}

output "protect_audit_controls_policy_id" {
  description = "ID of the audit-controls protection SCP."
  value       = aws_organizations_policy.protect_audit_controls.id
}

output "deny_root_access_policy_id" {
  description = "ID of the root-access denial SCP."
  value       = aws_organizations_policy.deny_root_access.id
}

output "restricted_zone_isolation_policy_id" {
  description = "ID of the restricted-zone isolation SCP."
  value       = aws_organizations_policy.restricted_zone_isolation.id
}
