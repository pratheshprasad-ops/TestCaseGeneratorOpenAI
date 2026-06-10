# Jira Test Case Generator

An Electron desktop application that retrieves a Jira issue, generates test
cases with OpenAI, uploads them to Zephyr Scale, and exports a CSV file.

## Configuration

The application reads configuration from environment variables. Copy the names
from `.env.example`, but do not commit real credentials.

Required for the standard OpenAI version:

- `JIRA_BASE_URL`
- `JIRA_USER_EMAIL`
- `JIRA_API_TOKEN`
- `OPENAI_API_KEY`
- `ZEPHYR_ACCESS_TOKEN`
- `ZEPHYR_OWNER_ID`

The Azure OpenAI variant uses `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT` instead of
`OPENAI_API_KEY`. `AZURE_OPENAI_API_VERSION` is optional.

For the packaged Windows application, set these as Windows user environment
variables and restart the application before generating test cases.

## Security

Never place real API keys in source files or commit a populated `.env` file.
Revoke any credential that has previously been committed or shared.
