// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

const jiraBaseUrl = process.env.JIRA_BASE_URL;
const jiraUserEmail = process.env.JIRA_USER_EMAIL;
const jiraApiToken = process.env.JIRA_API_TOKEN;
const zephyrAccessToken = process.env.ZEPHYR_ACCESS_TOKEN;
const zephyrOwnerId = process.env.ZEPHYR_OWNER_ID;
const apiBase = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

function validateConfiguration() {
    const missingVariables = [
        ['JIRA_BASE_URL', jiraBaseUrl],
        ['JIRA_USER_EMAIL', jiraUserEmail],
        ['JIRA_API_TOKEN', jiraApiToken],
        ['ZEPHYR_ACCESS_TOKEN', zephyrAccessToken],
        ['ZEPHYR_OWNER_ID', zephyrOwnerId],
        ['AZURE_OPENAI_ENDPOINT', apiBase],
        ['AZURE_OPENAI_API_KEY', apiKey],
        ['AZURE_OPENAI_DEPLOYMENT', deploymentId],
    ].filter(([, value]) => !value).map(([name]) => name);

    if (missingVariables.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
    }
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: false,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});

ipcMain.handle('generate-test-cases', async (event, url) => {
    try {
        validateConfiguration();
        const urlMatch = url.match(/browse\/([A-Z]+-\d+)/);
        if (!urlMatch) throw new Error('Invalid URL format. Ensure it includes the Jira issue key.');

        const ticketNumber = urlMatch[1];
        const projectKey = ticketNumber.split('-')[0];
        const jiraApiUrl = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/2/issue/${ticketNumber}`;

        // Fetch Jira ticket description
        const jiraResponse = await axios.get(jiraApiUrl, {
            headers: { 
                'Authorization': `Basic ${Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString('base64')}`,
                'Accept': 'application/json'
            }
        });
        const description = jiraResponse.data.fields.description || 'No description provided';

        // Generate test cases using OpenAI
        const openAiResponse = await axios.post(
            `${apiBase.replace(/\/$/, '')}/openai/deployments/${deploymentId}/chat/completions?api-version=${apiVersion}`, {
            messages: [
                { 
                    role: "system",
                    content: "You are an expert QA engineer. Generate detailed and thorough test cases for the given user story."
                },
                { 
                    role: "user", 
                    content: `Generate detailed test cases for every point mentioned in the acceptance criteria for the following user story: ${description}. Don't fill the expected results column. Each test case should be formatted as follows: 
                    Test Case: [Test Case Description]
                    - Expected Result: [Expected Result]
                    - Actual Result: [Actual Result]`
                }
            ],
            temperature: 0,
            top_p: 1,
            max_tokens: 800,
            stop: null,
            stream: false,
        }, {
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });

        console.log(openAiResponse);

        const testCases = openAiResponse.data.choices[0].message.content.trim();

        // Process the test cases response
        const testCaseLines = testCases.split('\n').filter(line => line.trim() !== '');

        let currentTestCase = '';
        let expectedResult = '';
        let actualResult = '';
        let serialNumber = 1;
        let csvContent = 'Sno,Test Case,Expected,Actual,Result\n';
        const structuredTestCases = [];

        const testCaseRegex = /^\d+\.\s\*\*Test Case: (.+)\*\*$/;
        const expectedResultRegex = /^\s*-\sExpected Result:\s(.+)$/;
        const actualResultRegex = /^\s*-\sActual Result:\s(.*)$/;

        testCaseLines.forEach(line => {
            const testCaseMatch = line.match(testCaseRegex);
            const expectedMatch = line.match(expectedResultRegex);
            const actualMatch = line.match(actualResultRegex);

            if (testCaseMatch) {
                if (currentTestCase) {
                    structuredTestCases.push({
                        name: currentTestCase.trim(),
                        objective: `Objective for ${currentTestCase.trim()}`,
                        precondition: '',
                        expectedResult: expectedResult.trim(),
                        actualResult: actualResult.trim()
                    });

                    csvContent += `${serialNumber},"${currentTestCase.replace(/"/g, '""')}","${expectedResult.replace(/"/g, '""')}","${actualResult.replace(/"/g, '""')}",""\n`;
                    serialNumber++;
                }

                // Start a new test case
                currentTestCase = testCaseMatch[1]; 
                expectedResult = '';
                actualResult = '';
            } else if (expectedMatch) {
                expectedResult = expectedMatch[1];
            } else if (actualMatch) {
                actualResult = actualMatch[1];
            }
        });

        if (currentTestCase) {
            structuredTestCases.push({
                name: currentTestCase.trim(),
                objective: `Objective for ${currentTestCase.trim()}`,
                precondition: '',
                expectedResult: expectedResult.trim(),
                actualResult: actualResult.trim()
            });

            csvContent += `${serialNumber},"${currentTestCase.replace(/"/g, '""')}","${expectedResult.replace(/"/g, '""')}","${actualResult.replace(/"/g, '""')}",""\n`;
        }

        // Create a folder in Zephyr Scale
        const folderResponse = await axios.post('https://api.zephyrscale.smartbear.com/v2/folders', {
            parentId: null,
            name: ticketNumber,
            projectKey: projectKey,
            folderType: "TEST_CASE"
        }, {
            headers: { 
                'Authorization': `Bearer ${zephyrAccessToken}`,
                'Content-Type': 'application/json'
            }
        });

        const folderId = folderResponse.data.id;

        // Upload test cases to Zephyr
        const uploadPromises = structuredTestCases.map(testCase => {
            return axios.post('https://api.zephyrscale.smartbear.com/v2/testcases', {
                projectKey: projectKey,
                name: testCase.name,
                objective: testCase.objective,
                precondition: testCase.precondition,
                estimatedTime: 0,
                componentId: null,
                priorityName: "Normal",
                statusName: "Draft",
                folderId: folderId,
                ownerId: zephyrOwnerId,
                labels: [],
                customFields: {}
            }, {
                headers: { 
                    'Authorization': `Bearer ${zephyrAccessToken}`,
                    'Content-Type': 'application/json'
                }
            });
        });

        const results = await Promise.all(uploadPromises);

        // Generate file path for CSV
        const filePath = path.join(os.homedir(), 'Desktop', `${ticketNumber}_test_cases.csv`);
        fs.writeFileSync(filePath, csvContent);

        return { success: true, filePath, testCases: structuredTestCases.length };
    } catch (error) {
        console.error('An error occurred:', error.message);
        return { success: false, message: error.message };
    }
});
