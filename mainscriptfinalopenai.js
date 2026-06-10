const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

const jiraBaseUrl = process.env.JIRA_BASE_URL;
const jiraUserEmail = process.env.JIRA_USER_EMAIL;
const jiraApiToken = process.env.JIRA_API_TOKEN;
const openAiApiKey = process.env.OPENAI_API_KEY;
const zephyrAccessToken = process.env.ZEPHYR_ACCESS_TOKEN;
const zephyrOwnerId = process.env.ZEPHYR_OWNER_ID;

function validateConfiguration() {
    const missingVariables = [
        ['JIRA_BASE_URL', jiraBaseUrl],
        ['JIRA_USER_EMAIL', jiraUserEmail],
        ['JIRA_API_TOKEN', jiraApiToken],
        ['OPENAI_API_KEY', openAiApiKey],
        ['ZEPHYR_ACCESS_TOKEN', zephyrAccessToken],
        ['ZEPHYR_OWNER_ID', zephyrOwnerId],
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
        const openAiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4",
            messages: [
                { 
                    role: "system",
                    content: "You are an expert QA engineer. Generate detailed and thorough test cases for the given user story."
                },
                { 
                    role: "user", 
                    content: `Generate detailed test cases for every point mentioned in the acceptance criteria for the following user story: ${description}. Each test case should be formatted as follows: 
                    Test Case: [Test Case Description]
                    - Expected Result: [Expected Result]`
                }
            ],
            max_tokens: 4000
        }, {
            headers: { 
                'Authorization': `Bearer ${openAiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const testCases = openAiResponse.data.choices[0].message.content.trim();

        // Process the test cases response
        const testCaseLines = testCases.split('\n').filter(line => line.trim() !== '');
        const structuredTestCases = [];
        let currentTestCase = '';
        let expectedResult = '';

        let csvContent = 'Sno,Test Case,Expected Result\n';
        let serialNumber = 1;

        testCaseLines.forEach(line => {
            if (line.startsWith('Test Case')) {
                if (currentTestCase) {
                    structuredTestCases.push({
                        name: currentTestCase.trim(),
                        objective: expectedResult.trim(),  // Move Expected Result to Objective
                        precondition: '',
                    });
                    csvContent += `${serialNumber},"${currentTestCase.replace(/"/g, '""')}","${expectedResult.replace(/"/g, '""')}"\n`;
                    serialNumber++;
                }
                currentTestCase = line.replace(/Test Case \d+:/, '').trim();
                expectedResult = '';
            } else if (line.startsWith('- Expected Result:')) {
                expectedResult = line.replace('- Expected Result:', '').trim();
            }
        });

        if (currentTestCase) {
            structuredTestCases.push({
                name: currentTestCase.trim(),
                objective: expectedResult.trim(),  // Move Expected Result to Objective
                precondition: '',
            });
            csvContent += `${serialNumber},"${currentTestCase.replace(/"/g, '""')}","${expectedResult.replace(/"/g, '""')}"\n`;
        }

        // Fetch existing folders with pagination
        let folderId = null;
        let startAt = 0;
        const maxResults = 100;
        let foldersResponse;
        do {
            foldersResponse = await axios.get('https://api.zephyrscale.smartbear.com/v2/folders', {
                params: {
                    projectKey: projectKey,
                    folderType: "TEST_CASE",
                    maxResults: maxResults,
                    startAt: startAt
                },
                headers: { 
                    'Authorization': `Bearer ${zephyrAccessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const folders = foldersResponse.data.values;
            const existingFolder = folders.find(folder => folder.name === ticketNumber);

            if (existingFolder) {
                folderId = existingFolder.id;
                break;
            }

            startAt += maxResults;
        } while (foldersResponse.data.isLast === false);

        if (!folderId) {
            // Create a new folder if no existing folder was found
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

            folderId = folderResponse.data.id;
        }

        // Upload test cases to Zephyr
        const uploadPromises = structuredTestCases.map(testCase => {
            return axios.post('https://api.zephyrscale.smartbear.com/v2/testcases', {
                projectKey: projectKey,
                name: testCase.name,
                objective: testCase.objective,  // Use Expected Result as Objective
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

        // Function to generate a unique file path
        function generateUniqueFilePath(filePath) {
            let uniqueFilePath = filePath;
            let counter = 1;
            while (fs.existsSync(uniqueFilePath)) {
                uniqueFilePath = filePath.replace(/(\d+)?\.csv$/, `${counter++}.csv`);
            }
            return uniqueFilePath;
        }

        // Generate file path for CSV and ensure it's unique
        const filePath = path.join(os.homedir(), 'Desktop', `${ticketNumber}_test_cases.csv`);
        const uniqueFilePath = generateUniqueFilePath(filePath);
        fs.writeFileSync(uniqueFilePath, csvContent);

        return { success: true, filePath: uniqueFilePath, testCases: structuredTestCases.length };
    } catch (error) {
        console.error('An error occurred:', error.message);
        return { success: false, message: error.message };
    }
});
