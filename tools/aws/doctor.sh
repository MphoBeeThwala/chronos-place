#!/usr/bin/env bash
# Read-only check of the AWS setup described in docs/aws-setup.md.
#   bash tools/aws/doctor.sh <aws-profile>
# It only calls Describe/List/Get APIs. It changes nothing and prints what is missing.
set -uo pipefail

PROFILE="${1:-}"
REGION="af-south-1"
if [[ -z "$PROFILE" ]]; then
  echo "usage: bash tools/aws/doctor.sh <aws-profile>   (for example chronos-mgmt)" >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI v2 is not installed. See docs/aws-setup.md, step A10." >&2
  exit 2
fi

failures=0
aws_() { aws --profile "$PROFILE" --output text "$@"; }
ok() { echo "  ok    $1"; }
bad() { echo "  FIX   $1" >&2; failures=$((failures + 1)); }
note() { echo "  note  $1"; }

echo "AWS setup check (profile: $PROFILE)"

identity="$(aws_ sts get-caller-identity --query 'Arn' 2>&1)" || {
  echo "Cannot call AWS with this profile. Try: aws sso login --profile $PROFILE" >&2
  echo "$identity" >&2
  exit 1
}
account_id="$(aws_ sts get-caller-identity --query 'Account')"
echo "  account $account_id as ${identity##*/}"
if [[ "$identity" == *":root" ]]; then bad "You are signed in as the ROOT user. Use an Identity Center profile instead (steps A9 and A10)."; else ok "signed in through a role, not as root"; fi
if [[ "$identity" == *"AWSReservedSSO_"* ]]; then ok "signed in through IAM Identity Center"; else note "not an Identity Center session (AWSReservedSSO_ role expected)"; fi

# Organization
if org="$(aws_ organizations describe-organization --query '[Id,FeatureSet,MasterAccountId]' 2>/dev/null)"; then
  read -r org_id features management <<<"$org"
  ok "organisation $org_id exists (management account $management)"
  [[ "$features" == "ALL" ]] && ok "all features enabled" || bad "Organizations is not in ALL features mode (step A4)"
  if [[ "$management" == "$account_id" ]]; then
    ok "this profile is the management account"

    policies="$(aws_ organizations describe-organization --query 'Organization.AvailablePolicyTypes[?Type==`SERVICE_CONTROL_POLICY`].Status' 2>/dev/null)"
    [[ "$policies" == "ENABLED" ]] && ok "service control policies enabled" || bad "enable service control policies (step A5)"

    names="$(aws_ organizations list-accounts --query 'Accounts[?Status==`ACTIVE`].Name' 2>/dev/null | tr '\t' '\n')"
    for expected in chronos-security chronos-shared-services chronos-dev chronos-restricted-dev; do
      if grep -qx "$expected" <<<"$names"; then ok "account $expected exists"; else bad "account $expected is missing (step A7)"; fi
    done

    root_id="$(aws_ organizations list-roots --query 'Roots[0].Id' 2>/dev/null)"
    ou_names="$(aws_ organizations list-organizational-units-for-parent --parent-id "$root_id" --query 'OrganizationalUnits[].Name' 2>/dev/null | tr '\t' '\n')"
    for expected in Security Infrastructure Workloads Restricted; do
      if grep -qx "$expected" <<<"$ou_names"; then ok "OU $expected exists"; else bad "OU $expected is missing (step A6)"; fi
    done

    services="$(aws_ organizations list-aws-service-access-for-organization --query 'EnabledServicePrincipals[].ServicePrincipal' 2>/dev/null | tr '\t' '\n')"
    for principal in cloudtrail.amazonaws.com guardduty.amazonaws.com securityhub.amazonaws.com config.amazonaws.com account.amazonaws.com sso.amazonaws.com ram.amazonaws.com; do
      if grep -qx "$principal" <<<"$services"; then ok "trusted access: $principal"; else bad "enable trusted access for $principal (step A5)"; fi
    done

    if [[ -n "${root_id:-}" ]]; then
      instances="$(aws --profile "$PROFILE" --region "$REGION" --output text sso-admin list-instances --query 'Instances[0].InstanceArn' 2>/dev/null)"
      if [[ -n "$instances" && "$instances" != "None" ]]; then ok "IAM Identity Center is enabled in $REGION"; else bad "IAM Identity Center is not enabled in $REGION (step A9). If you chose another region, that is fine: tell me which."; fi
    fi
  else
    note "run this with the management-account profile to check the organisation setup"
  fi
else
  bad "No AWS Organization found for this account (step A4)"
fi

# Region
status="$(aws --profile "$PROFILE" --output text account get-region-opt-status --region-name "$REGION" --query 'RegionOptStatus' 2>/dev/null)"
case "$status" in
  ENABLED|ENABLED_BY_DEFAULT) ok "$REGION is enabled in this account" ;;
  ENABLING) note "$REGION is still being enabled; wait a few minutes" ;;
  *) bad "$REGION is not enabled in this account (steps A3 and A8)" ;;
esac

# Budgets
budgets="$(aws --profile "$PROFILE" --region us-east-1 --output text budgets describe-budgets --account-id "$account_id" --query 'length(Budgets)' 2>/dev/null)"
if [[ -n "$budgets" && "$budgets" != "0" && "$budgets" != "None" ]]; then ok "$budgets budget(s) configured"; else bad "no budget found: set one up before creating resources (step A2)"; fi

echo
if (( failures > 0 )); then
  echo "$failures item(s) to fix. Work through the steps named above, then run this again."
  exit 1
fi
echo "Everything this script checks is in place."
