#!/usr/bin/env bash
# The CloudFormation template archive of deploy-test-rollback.yml. Each template a stack runs is saved to
# s3://$TEMPLATES_BUCKET/<stack>/<timestamp>/template.json and recorded in the $TEMPLATES_TABLE table
# (stackName + deployedAt). A record is stable once the integration tests passed on it; a rollback
# updates the stack back to the newest stable template. Both live in rollback-service-<env>.
#
# Needs STACK_NAME, TEMPLATES_TABLE, TEMPLATES_BUCKET and AWS_REGION, plus AWS credentials.
#
#   stack-templates.sh baseline-needed            "true" if the stack runs a template that was never archived
#   stack-templates.sh archive <source> [stable] [rolled-back-from]
#                                                 archives the template the stack runs now, prints its deployedAt
#   stack-templates.sh mark-stable <deployedAt>   the tests passed on it
#   stack-templates.sh mark-rolled-back <deployedAt>
#   stack-templates.sh latest-stable <before>     the newest stable record before <before>, as JSON (empty: none)
#   stack-templates.sh restore <deployedAt>       updates the stack to that record's template, waits for it
set -euo pipefail

: "${STACK_NAME:?}" "${TEMPLATES_TABLE:?}" "${TEMPLATES_BUCKET:?}" "${AWS_REGION:?}"
WORK_DIR="${RUNNER_TEMP:-/tmp}"

# The template the stack runs, as compact JSON with sorted keys, so the same template always has the same hash.
# The CLI returns a JSON template as an object (CDK templates are JSON), a YAML one as a string.
current_template() {
  aws cloudformation get-template --stack-name "$STACK_NAME" --template-stage Original \
    --query TemplateBody --output json \
    | jq -cS 'if type == "string" then fromjson else . end'
}

stack_status() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

parameter_keys() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --output json | jq -c '[.Stacks[0].Parameters // [] | .[].ParameterKey]'
}

# Every record of the stack, newest first.
records() {
  aws dynamodb query --table-name "$TEMPLATES_TABLE" --consistent-read --no-scan-index-forward \
    --key-condition-expression 'stackName = :s' \
    --expression-attribute-values "$(jq -n --arg s "$STACK_NAME" '{":s": {S: $s}}')" \
    --output json
}

key_of() { jq -n --arg s "$STACK_NAME" --arg at "$1" '{stackName: {S: $s}, deployedAt: {S: $at}}'; }

case "${1:-}" in
  baseline-needed)
    # Nothing to archive before the first deploy, or while the stack is mid-update or failed.
    if ! [[ "$(stack_status)" =~ ^(CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)$ ]]; then
      echo false; exit 0
    fi
    sha=$(current_template | sha256sum | cut -d' ' -f1)
    # Any record with this template, stable or not: a template that failed its tests is never re-archived as stable.
    if records | jq -e --arg sha "$sha" 'any(.Items[]; .templateSha256.S == $sha)' >/dev/null; then echo false; else echo true; fi
    ;;

  archive)
    source="${2:?source}" stable="${3:-false}" from="${4:-}"
    now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    key="$STACK_NAME/$(sed 's/[-:]//g; s/\.[0-9]*//' <<<"$now")/template.json"
    current_template > "$WORK_DIR/template.json"
    sha=$(sha256sum < "$WORK_DIR/template.json" | cut -d' ' -f1)
    aws s3 cp "$WORK_DIR/template.json" "s3://$TEMPLATES_BUCKET/$key" --content-type application/json --only-show-errors >&2
    aws dynamodb put-item --table-name "$TEMPLATES_TABLE" --condition-expression 'attribute_not_exists(deployedAt)' \
      --item "$(jq -n --arg stack "$STACK_NAME" --arg at "$now" --arg bucket "$TEMPLATES_BUCKET" --arg key "$key" \
        --arg sha "$sha" --arg params "$(parameter_keys)" --arg source "$source" --argjson stable "$stable" --arg from "$from" \
        --arg actor "github:${GITHUB_ACTOR:-unknown}" --arg commit "${GITHUB_SHA:-}" \
        --arg run "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
        '{stackName: {S: $stack}, deployedAt: {S: $at}, templateBucket: {S: $bucket}, templateKey: {S: $key},
          templateSha256: {S: $sha}, parameterKeys: {S: $params}, source: {S: $source}, actor: {S: $actor},
          commitSha: {S: $commit}, runUrl: {S: $run}, stable: {BOOL: $stable}}
         + (if $stable then {verifiedAt: {S: $at}} else {} end)
         + (if $from != "" then {rolledBackFrom: {S: $from}} else {} end)')"
    echo "Archived $STACK_NAME's template ($source, stable: $stable) to s3://$TEMPLATES_BUCKET/$key" >&2
    echo "$now"
    ;;

  mark-stable)
    now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    aws dynamodb update-item --table-name "$TEMPLATES_TABLE" --key "$(key_of "${2:?deployedAt}")" \
      --condition-expression 'attribute_exists(deployedAt)' \
      --update-expression 'SET stable = :true, verifiedAt = :now' \
      --expression-attribute-values "$(jq -n --arg now "$now" '{":true": {BOOL: true}, ":now": {S: $now}}')"
    ;;

  mark-rolled-back)
    now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    aws dynamodb update-item --table-name "$TEMPLATES_TABLE" --key "$(key_of "${2:?deployedAt}")" \
      --condition-expression 'attribute_exists(deployedAt)' \
      --update-expression 'SET stable = :false, rolledBackAt = :now' \
      --expression-attribute-values "$(jq -n --arg now "$now" '{":false": {BOOL: false}, ":now": {S: $now}}')"
    ;;

  latest-stable)
    records | jq -c --arg before "${2:?before}" '
      [.Items[] | select(.deployedAt.S < $before and .stable.BOOL == true and .rolledBackAt == null)][0]
      // empty
      | {deployedAt: .deployedAt.S, source: .source.S, commitSha: .commitSha.S, templateBucket: .templateBucket.S,
         templateKey: .templateKey.S, templateSha256: .templateSha256.S, parameterKeys: (.parameterKeys.S | fromjson)}'
    ;;

  restore)
    record=$(aws dynamodb get-item --table-name "$TEMPLATES_TABLE" --key "$(key_of "${2:?deployedAt}")" --consistent-read --output json)
    bucket=$(jq -r '.Item.templateBucket.S' <<<"$record")
    key=$(jq -r '.Item.templateKey.S' <<<"$record")
    [[ "$bucket" != null ]] || { echo "No template of $STACK_NAME recorded at $2" >&2; exit 1; }
    # Keep each parameter's current value (CDK's BootstrapVersion), if the stack still has it;
    # parameters only the current template has fall back to the old template's defaults.
    params=()
    for name in $(jq -r --argjson now "$(parameter_keys)" '.Item.parameterKeys.S | fromjson | map(select(. as $k | $now | index($k))) | .[]' <<<"$record"); do
      params+=("ParameterKey=$name,UsePreviousValue=true")
    done
    echo "Updating $STACK_NAME to the template recorded at $2 (s3://$bucket/$key)" >&2
    if ! out=$(aws cloudformation update-stack --stack-name "$STACK_NAME" \
        --template-url "https://$bucket.s3.$AWS_REGION.amazonaws.com/$key" \
        ${params[@]+--parameters "${params[@]}"} \
        --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND 2>&1); then
      if grep -q 'No updates are to be performed' <<<"$out"; then
        echo "$STACK_NAME already runs that template" >&2; exit 0
      fi
      echo "$out" >&2; exit 1
    fi
    aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME"
    echo "$STACK_NAME runs the template recorded at $2 again" >&2
    ;;

  *)
    sed -n '2,17p' "$0" >&2
    exit 1
    ;;
esac
