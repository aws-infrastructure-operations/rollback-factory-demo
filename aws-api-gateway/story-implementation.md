## For each feature create a new branch from origin main and raise a PR or let me raise it

1. Build an API gateway with stage deployment
 - we need to use AWS CDK with typescript here
 - api name should be api-user-dev/prod
 - api should be simple and to have 2 enpoints with GET and POST message both
 - api should use cognito as authorizer (you can create a lambda for it)
 - before deploying the API, 
    - create / update a collection for postman / bruno to call the endpoints and a script to get the token from cognito
    - store the API gateway JSON/yaml openAPI spec file into a s3 bucket with the name (apigatewayname-awsaccount-deployments-datetimestamp)
 - add a dynamodb table to record each deployment made (manually or automatic via CICD)
 - add integration steps for the API gateway
 - for the API gateway create an ALARM for 4xx and one for 5xx and which has as option to send an sns notification
 - sns notification should invoke a lambda which can perform rollback on the API gateway stage and assuming something is wrong and if a deployment was made in the past X minutes. Will look at the previous version of the API gateway JSON/yaml and redeploy that by overriding the stage v1
  - we should have a github workflow to
    - deploy the api with everythign I've said earlier (record, store yaml/json)
    - run integration testing
    - move to prod API if everything is green
    - if any error appear in API gateway and alarm is triggered, then rollback