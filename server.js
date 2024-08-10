const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');

// Create Express app
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const mediaDir = path.join(__dirname, 'uploaded-media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir);
        }
        cb(null, mediaDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// MySQL connection configuration
const con = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "whatsapp_data"
});

// Connect to MySQL
con.connect(function(err) {
    if (err) {
        console.error("Error connecting to database:", err)
        throw err; // Exit on connection error
    }
    console.log("Connected to MySQL database!");
});

// Store clients
const clients = {};

// Function to create a new client
const createClient = (clientId) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: {
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    // Client ready event
    client.on('ready', () => {
        console.log(`Client ${clientId} is ready!`);
        clients[clientId] = client; // Store the client in the clients object
    });

    // QR code event
    client.on('qr', qr => {
        console.log(`QR Code for Client ${clientId}:`);
        qrcode.generate(qr, { small: true });
    });

    // Client error event
    client.on('error', error => {
        console.error(`Client ${clientId} error:`, error);
    });

    // Initialize client
    client.initialize().then(() => {
        console.log(`Client ${clientId} initialized successfully!`);
    }).catch(error => {
        console.error(`Initialization error for Client ${clientId}:`, error);
    });
};

// Create only client2
createClient('client2');

// Define route to handle sending messages from React frontend
app.get('/clientstatus/:clientId', (req, res) => {
    const clientId = req.params.clientId;
    const client = clients[clientId];

    if (client) {
        res.send({ isReady: client.info ? true : false });
    } else {
        res.status(404).send('Client not found');
    }
});

// Handle message sending, including image and document uploads
app.post('/sendmessage', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'document', maxCount: 1 }]), (req, res) => {
    const { fromNumber, toNumber, text } = req.body;
    const client = clients['client2'];

    if (client) {
        const fetchNameSql = 'SELECT name FROM sentdata WHERE `from-user` = ?';
        con.query(fetchNameSql, [toNumber], (err, result) => {
            if (err) {
                console.error('Error fetching recipient name:', err);
                return res.status(500).send('Error fetching recipient name');
            }

            const recipientName = result[0]?.name || 'User'; // Default to 'User' if no name found
            let personalizedMessage = text;

            // Check if <name> placeholder is in the message
            if (text.includes('<name>')) {
                personalizedMessage = text.replace('<name>', recipientName);
            }

            const formattedTo = `${toNumber}@c.us`;

            // Determine the URLs if image or document was uploaded
            const imageUrl = req.files['image'] ? `http://localhost:3001/uploaded-media/${req.files['image'][0].filename}` : null;
            const documentUrl = req.files['document'] ? `http://localhost:3001/uploaded-media/${req.files['document'][0].filename}` : null;

            // Create a promise to send the message
            let sendMessagePromise;
            if (imageUrl || documentUrl) {
                const mediaPromises = [];

                if (imageUrl) {
                    const imagePath = path.join(__dirname, 'uploaded-media', req.files['image'][0].filename);
                    const imageMedia = MessageMedia.fromFilePath(imagePath);
                    mediaPromises.push(client.sendMessage(formattedTo, imageMedia, { caption: personalizedMessage }));
                }

                if (documentUrl) {
                    const documentPath = path.join(__dirname, 'uploaded-media', req.files['document'][0].filename);
                    const documentMedia = MessageMedia.fromFilePath(documentPath);
                    mediaPromises.push(client.sendMessage(formattedTo, documentMedia, { caption: personalizedMessage }));
                }

                sendMessagePromise = Promise.all(mediaPromises);
            } else {
                sendMessagePromise = client.sendMessage(formattedTo, personalizedMessage);
            }

            sendMessagePromise.then(response => {
                console.log(`Message sent from ${fromNumber} to ${toNumber}: ${personalizedMessage}`);

                // Capture current date and time
                const currentDate = new Date().toISOString().slice(0, 10);
                const currentTime = new Date().toLocaleTimeString();

                // Save message details to the database
                const insertMessageSql = 'INSERT INTO sentdata (`from-user`, `to-user`, `name`, `message`, `url`, `date`, `time`) VALUES (?, ?, ?, ?, ?, ?, ?)';
                const insertMessageValues = [fromNumber, toNumber, recipientName, personalizedMessage, imageUrl || documentUrl, currentDate, currentTime];

                con.query(insertMessageSql, insertMessageValues, (err, result) => {
                    if (err) {
                        console.error('Error updating sentdata table:', err);
                        return res.status(500).send('Error updating sentdata table');
                    }

                    console.log('Message details logged in sentdata table');
                    res.status(200).send('Message sent successfully');
                });

            }).catch(err => {
                console.error(`Error sending message from ${fromNumber} to ${toNumber}:`, err);
                res.status(500).send('Error sending message');
            });
        });
    } else {
        res.status(404).send('Client not found');
    }
});

// Start Express server
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
