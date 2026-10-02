# AWS setup runbook

A step-by-step guide to preparing AWS for Chronos Place, written for someone starting with one new AWS account. It is the groundwork for M0.11 (Terraform foundations). Nothing here is applied by the repository: you do these steps in the AWS console or CLI, and the Terraform in `infra/terraform` takes over once they are done.

**Rules that apply throughout**

- AWS has no "projects". The equivalent boundary is an **account**. We use several accounts on purpose: a mistake or a breach in one cannot reach the others, and the Health Vault lives in accounts that almost nobody can enter (TECHNICAL_SPEC 10.1).
- **Never paste an access key, secret key, session token, password or MFA seed into a chat, an issue or the repository.** Account IDs, organisation IDs and region names are fine to share.
- Work as an Identity Center user (Part A9), not as the root user, as soon as that exists.
- Menu names change over time. If a screen differs from what is written here, trust the screen and keep the intent.
- Cost: everything in Part A costs close to nothing. The expensive services (EKS, MSK, CloudHSM) only arrive in later Terraform phases and only when you approve them.

Plan on one to two hours for Part A.

## Accounts and organisational units we are building

| Account name | Purpose | Create now? |
| --- | --- | --- |
| `chronos-management` | Your existing account: AWS Organizations, billing and policies only. No workloads. | exists |
| `chronos-security` | GuardDuty, Security Hub, organisation CloudTrail, log archive | yes |
| `chronos-shared-services` | Terraform state, container registry (ECR), CI roles | yes |
| `chronos-dev` | Core workloads for development | yes |
| `chronos-restricted-dev` | Disclosure Service and Health Vault, development | yes |
| `chronos-staging`, `chronos-prod` | Core workloads | later |
| `chronos-restricted-staging`, `chronos-restricted-prod` | Health Vault | later |

```
Root
├── Security            (chronos-security)
├── Infrastructure      (chronos-shared-services)
├── Workloads
│   ├── Dev             (chronos-dev)
│   ├── Staging
│   └── Prod
└── Restricted
    ├── NonProd         (chronos-restricted-dev, later restricted-staging)
    └── Prod            (later chronos-restricted-prod)
```

Policies attach to organisational units (OUs), so the `Restricted` OU can have stricter rules than `Workloads`.

## Part A: do these now

### A1. Secure the root user of your existing account
1. Sign in as the root user. Account name (top right) > **Security credentials**.
2. **Assign MFA**: a passkey or hardware key is best; an authenticator app is the minimum. Register a second MFA device if you can, and store it somewhere separate.
3. Delete any **access keys** on the root user. There should be none.
4. Use a long, unique password in a password manager. The root email address should be a mailbox you will always control.
5. Account name > **Account** > **Alternate contacts**: fill in Billing, Operations and Security (an email you read).

*Verify:* the Security credentials page shows MFA assigned and no access keys.

### A2. Put cost guardrails in place before creating anything
1. **Billing and Cost Management** > **Budgets** > create a **monthly cost budget** (start low, for example US$100) with email alerts at 50%, 80% and 100% of actual spend and at 100% forecast.
2. **Cost Anomaly Detection**: create a monitor for all services with an email alert.
3. **Cost Explorer**: enable it (first use takes about a day to fill).

*Verify:* the budget appears and a test alert email arrives (use the budget's "test" or lower the amount briefly).

### A3. Enable the Cape Town region
Africa (Cape Town), `af-south-1`, is an **opt-in region**: it is off until you enable it.
1. Account name > **Account** > **AWS Regions** > find **Africa (Cape Town)** > **Enable**. It takes a few minutes.
2. Make af-south-1 your working region in the console region picker.

*Verify:* the status shows **Enabled**.

### A4. Create the organisation
1. Open **AWS Organizations** > **Create an organization**. Leave **all features** on (the default).
2. Open the verification email AWS sends and confirm it.

*Verify:* Organizations shows your account as the **management account**.

### A5. Turn on the organisation features we need
1. Organizations > **Policies** > **Service control policies** > **Enable**.
2. Organizations > **Services** > enable trusted access for: **AWS CloudTrail**, **Amazon GuardDuty**, **AWS Security Hub**, **AWS Config**, **AWS Account Management**, **IAM Identity Center** and **AWS Resource Access Manager** (use **Enable trusted access** on each).

*Verify:* the Service control policies page shows **Enabled**, and the services list shows trusted access for each service above.

### A6. Create the organisational units
Organizations > **AWS accounts** > select **Root** > **Actions** > **Create new** under Organizational unit. Create, in this order: `Security`, `Infrastructure`, `Workloads`, `Restricted`. Then inside `Workloads` create `Dev`, `Staging`, `Prod`; inside `Restricted` create `NonProd`, `Prod`.

*Verify:* the tree matches the diagram above.

### A7. Create the member accounts
For each account marked "yes" in the table (`chronos-security`, `chronos-shared-services`, `chronos-dev`, `chronos-restricted-dev`):
1. Organizations > **AWS accounts** > **Add an AWS account** > **Create an AWS account**.
2. **Account name** as in the table. **Email**: each account needs its own address. Gmail plus-addressing works for a start (for example `yourname+chronos-security@gmail.com`), but an address on your own domain that goes to a shared mailbox is better long term, because that email is the key to the account's root user. Keep a record of which email belongs to which account.
3. Leave the IAM role name as `OrganizationAccountAccessRole`. Create.
4. When each is ready, **move it into its OU** (select the account > **Move**): security > `Security`, shared-services > `Infrastructure`, dev > `Workloads/Dev`, restricted-dev > `Restricted/NonProd`.

Account deletion is slow and awkward, so create only these four now. Staging, production and the other restricted accounts come later.

*Verify:* four new accounts show **Active**, each in the right OU.

### A8. Enable the new region for each member account and centralise root access
1. In the management account's CloudShell (or CLI), once per member account ID:
   `aws organizations enable-aws-service-access --service-principal account.amazonaws.com`
   `aws account enable-region --account-id <ACCOUNT_ID> --region-name af-south-1`
2. **IAM** > **Root access management** > **Enable** both *Root credentials management* and *Privileged root actions in member accounts*. This lets you remove and recover root credentials for member accounts centrally, so you never have to keep their root passwords or MFA devices.

*Verify:* `aws account get-region-opt-status --account-id <ACCOUNT_ID> --region-name af-south-1` shows `ENABLED` for each account.

### A9. Set up sign-in with IAM Identity Center
This replaces long-lived IAM users and access keys.
1. Open **IAM Identity Center** and choose the **region** (an organisation instance cannot be moved later; choose `af-south-1`, or tell me if the console doesn't offer it). **Enable** with AWS Organizations.
2. **Settings** > **Authentication** > **Configure multi-factor authentication**: require MFA for all users, allow passkeys and authenticator apps.
3. **Groups** > create `platform-admins`, `platform-readonly`, and `restricted-admins`.
4. **Users** > **Add user**: yourself, with a real email, and add yourself to `platform-admins` and `restricted-admins`. Accept the invitation email and register MFA.
5. **Permission sets** > create:
   - `AdministratorAccess` (AWS managed policy `AdministratorAccess`, session duration **4 hours**).
   - `ReadOnly` (AWS managed policies `ReadOnlyAccess` and `job-function/ViewOnlyAccess`, session duration 8 hours).
6. **AWS accounts** > assign:
   - `platform-admins` + `AdministratorAccess` to `chronos-management`, `chronos-security`, `chronos-shared-services` and `chronos-dev`.
   - `restricted-admins` + `AdministratorAccess` to `chronos-restricted-dev` only. (For production restricted accounts, the security owner approves access; see TECHNICAL_SPEC 8.)
   - `platform-readonly` + `ReadOnly` to all accounts.
7. Note the **AWS access portal URL** (shown on the Identity Center dashboard).

*Verify:* signing in at the access portal URL with MFA shows each account and its role.

### A10. Install the tools and sign in from your computer
1. Install **AWS CLI v2** (docs.aws.amazon.com/cli, "Install or update") and check `aws --version`.
2. Run `aws configure sso` once per account you need first, with these profile names: `chronos-mgmt`, `chronos-shared`, `chronos-dev`, `chronos-restricted-dev`. Use the access portal URL, `af-south-1`, and the `AdministratorAccess` role.
3. Sign in with `aws sso login --profile chronos-mgmt`, then check: `aws sts get-caller-identity --profile chronos-mgmt`. The ARN should contain `assumed-role/AWSReservedSSO_AdministratorAccess`, **not** `:root`.
4. Terraform runs in Docker in this repository (see the root README), so you do not need to install it.

### A11. Check your work
Run the read-only checker. It only reads, changes nothing, and tells you what is missing:

```sh
bash tools/aws/doctor.sh chronos-mgmt
```

### A12. What to send back
Reply with these (they are identifiers, not secrets):
- Organization ID (`o-xxxxxxxxxx`) and the management account ID.
- The four member account IDs and their names.
- The OU IDs (`ou-xxxx-xxxxxxxx`) for `Security`, `Infrastructure`, `Dev`, `NonProd` and `Restricted`.
- The Identity Center region and access portal URL.
- The email address that should receive security alerts.
- The output of `tools/aws/doctor.sh`.

## Part B: what happens next

With that information I write Terraform in reviewed pull requests (the phases in the M0.11 plan). You run `terraform plan` and `terraform apply` yourself with your SSO profile, because I cannot and should not hold credentials. For each pull request I will tell you the exact commands and what the plan should show.

Order: (1) the state bucket and the account structure in code; (2) organisation SCPs, attached first to the `Dev` OU only to test them; (3) the security baseline in `chronos-security`; (4) KMS and Secrets Manager; then networking, data stores and compute in later pull requests.

## Part C: safety notes and undoing things

- **SCPs can lock you out.** They never apply to the management account, so you can always recover from there. We test them on one OU first.
- **Accounts are hard to delete.** Closing one puts it in a 90-day suspended state. That is why only four are created now.
- **Costs to watch:** NAT gateways, EKS, MSK and CloudHSM are the big ones. They are not created until their phase.
- If you lose access to the root user or your MFA device, use AWS's account recovery, and do it before you have production data.

## Part D: legal and privacy tasks that run alongside

These are not engineering work, but the PRD gates a private beta on them:
- In the console, open **AWS Artifact** and review and accept the AWS **Data Processing Addendum** for your organisation.
- Appoint a privacy lawyer and the Information Officer (PRD "Next steps"), and confirm data-residency questions in writing, including CDN caching of photos (ADR-0011) and any transfer outside South Africa.
