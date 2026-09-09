const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

require('dotenv').config();
const knex = require('knex')({
    client: 'pg',
    connection: {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 5432,
    },
    pool: {
        min: 2,
        max: 10,
        acquireTimeoutMillis: 30000
    }
});

let tableName;
let fileQueue = [];

function createWindow () {
    const mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    ipcMain.on('table-name', (event, name) => {
        if (name) {
            tableName = name;
            openFileDialog(mainWindow, tableName);
        } else {
            mainWindow.close();
        }
    });
}

function openFileDialog(mainWindow) {
    dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(result => {
        if (!result.canceled && result.filePaths.length > 0) {
            fileQueue = result.filePaths;
            processNextFile(mainWindow);
        }
    });
}

async function processNextFile(mainWindow) {
    if (fileQueue.length === 0) {
        dialog.showMessageBox(mainWindow, {
            message: 'Todos los archivos han sido procesados.',
            buttons: ['Aceptar']
        }).then(() => {
            mainWindow.close();
        });
        return;
    }

    await delay(3000);

    const nextFilePath = fileQueue.shift();
    processFile(nextFilePath, mainWindow);
}

function detectSeparator(filePath) {
    const buffer = Buffer.alloc(1024);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);
    const firstLine = buffer.toString('utf8').split('\n')[0];
    return firstLine.includes(';') ? ';' : ',';
}

function processFile(inputFilePath, mainWindow) {
    let batch = [];

    const separator = detectSeparator(inputFilePath);
    const readStream = fs.createReadStream(inputFilePath);
    const fileName = path.basename(inputFilePath);

    readStream
        .pipe(csv({ separator }))
        .on('data', (row) => {
            if (row['NOM_COM_RBD']) {
                row['NOM_COM_RBD'] = row['NOM_COM_RBD'].replace(/[^a-z0-9\sáéíóúñ]/gi, '');
            }
            if (row['NOM_DEPROV_RBD']) {
                row['NOM_DEPROV_RBD'] = row['NOM_DEPROV_RBD'].replace(/[^a-z0-9\sáéíóúñ]/gi, '');
            }

            row = Object.entries(row).reduce((acc, [key, value]) => {
                let sanitizedKey = key.replace(/[^a-z0-9_]/gi, '');
                acc[sanitizedKey.toLowerCase()] = value;

                return acc;
            }, {});

            batch.push(row);

        })
        .on('end', async () => {
            await insertData(batch, mainWindow, fileName);
            await processNextFile(mainWindow);
        });
}

app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
async function insertData(batch, mainWindow, fileName) {
    const size = ['inscritos_puntajes_paes', 'inscritos_puntajes_ptu'].includes(tableName) ? 500 : 2000;
    const chunks = await chunkData(batch, size);
    const schema = 'pathfinder_public';

    await knex.transaction(async (trx) => {
        for (let i = 0; i < chunks.length; i++) {
            await trx.batchInsert(`${schema}.${tableName}`, chunks[i]);
            console.log(`[${fileName}] Chunk ${i + 1}/${chunks.length} ✓`);
        }
    });

    console.log(`Archivo '${fileName}' insertado en '${tableName}'.`);
}

async function chunkData(batch, size = 2000) {
    const chunkedArray = [];
    for (let i = 0; i < batch.length; i += size) {
        chunkedArray.push(batch.slice(i, i + size));
    }

    return chunkedArray;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}