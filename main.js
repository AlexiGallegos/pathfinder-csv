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
});

let tableName;

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
        properties: ['openFile'],
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(result => {
        if (!result.canceled && result.filePaths.length > 0) {
            const inputFilePath = result.filePaths[0];
            processFile(inputFilePath, mainWindow);
        }
    });
}

function processFile(inputFilePath, mainWindow) {
    let batch = [];

    const readStream = fs.createReadStream(inputFilePath);
    const fileName = path.basename(inputFilePath);

    readStream
        .pipe(csv({separator: ';'}))
        .on('data', (row) => {
            if (row['NOM_COM_RBD']) {
                row['NOM_COM_RBD'] = row['NOM_COM_RBD'].replace(/[^a-z0-9\sáéíóúñ]/gi, '');
            }
            if (row['NOM_DEPROV_RBD']) {
                row['NOM_DEPROV_RBD'] = row['NOM_DEPROV_RBD'].replace(/[^a-z0-9\sáéíóúñ]/gi, '');
            }

            row = Object.entries(row).reduce((acc, [key, value]) => {
                acc[key.toLowerCase()] = value;
                return acc;
            }, {});

            batch.push(row);

        })
        .on('end', async () => {
            await insertData(batch, mainWindow, fileName);
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
    const chunkedData = await chunkData(batch);
    let lotesInsertados = 0;
    let schema = 'pathfinder_public';

    for (const chunk of chunkedData) {
        try {
            await knex.batchInsert(`${schema}.${tableName}`, chunk);
            lotesInsertados++;
            console.log(`Lote ${lotesInsertados} insertado correctamente`);
        } catch (error) {
            console.error('Error al insertar datos:', error);
        }
    }

    dialog.showMessageBox(mainWindow, {
        message: `El archivo '${fileName}' ha sido procesado e insertado correctamente. ¿Desea procesar otro archivo?`,
        buttons: ['Sí', 'No'],
        defaultId: 0,
        cancelId: 1
    }).then(response => {
        if (response.response === 0) {
            openFileDialog(mainWindow);
        } else {
            mainWindow.close();
        }
    });
}

async function chunkData(batch, size = 2000) {
    const chunkedArray = [];
    for (let i = 0; i < batch.length; i += size) {
        chunkedArray.push(batch.slice(i, i + size));
    }

    return chunkedArray;
}
