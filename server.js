import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo"; // Для збереження сесій у базі
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { nanoid } from "nanoid";
import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import { translations } from './translations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. MONGODB ATLAS ---
const app = express();
const PORT = process.env.PORT || 10000;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
const uri = "mongodb+srv://";

mongoose.connect(uri)
  .then(() => console.log("✅ Підключено до MongoDB Atlas!"))
  .catch(err => console.error("❌ Помилка підключення до бази:", err));

// --- 2.(Mongoose Schemas) ---

// Користувачі
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    passwordHash: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: String,
    role: { type: String, default: 'user' },
    favorites: [String], // Масив ID улюблених оголошень
    emailVerified: { type: Boolean, default: false },
    verificationToken: String,
    resetToken: String,
    resetTokenExpires: Date,
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// Оголошення
const OfferSchema = new mongoose.Schema({
    id: { type: String, default: () => nanoid(), unique: true }, // Використовуємо nanoid для гарних URL
    title: String,
    description: String,
    price: Number,
    city: String,
    district: String,
    area: Number,
    rooms: Number,
    type: String,
    category: String,
    images: [String],
    coverIndex: { type: Number, default: 0 },
    status: { type: String, default: 'active' },
    user: String, // Email власника
    createdAt: { type: Date, default: Date.now }
});
const Offer = mongoose.model('Offer', OfferSchema);

// Налаштування та Словники (Те, що просив викладач!)
const SettingsSchema = new mongoose.Schema({
    key: String, // Наприклад, "main_config"
    dictionary: Object, // Тут будуть міста {name: "Warszawa", enabled: true}
    ui: Object,
    settings: Object
}, { collection: 'globalsettings' }); // Вказуємо точну назву колекції
const Settings = mongoose.model('Settings', SettingsSchema);

// Сторінки (CMS)
const PageSchema = new mongoose.Schema({
    key: String, // Наприклад, "home", "about"
    pl: Object,
    en: Object,
    ua: Object
});
const Page = mongoose.model('Page', PageSchema);

// Логи дій
const LogSchema = new mongoose.Schema({
    action: String,
    user: String,
    time: { type: Date, default: Date.now }
});
const Log = mongoose.model('Log', LogSchema);

// Функція логування
async function addLog(action, user) {
    try {
        const username = user?.email || user?.username || "system";
        await Log.create({ action, user: username });
    } catch (e) {
        console.error("Log error:", e);
    }
}

// --- 3. APP ---

// Пошта
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: "",
        pass: ""
    }
});

// Завантаження файлів (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = "public/uploads";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, name + ext);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) return cb(new Error("Tylko grafika!"));
        cb(null, true);
    }
});

// Express Setup
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Сесії через MongoDB (щоб не злітали при перезапуску!)
app.use(session({
    secret: "",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: uri }), // Зберігаємо сесії в Atlas
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 день
}));

// --- MIDDLEWARES ---

// 1. Основні дані (Мова, переклади, конфіг)
// 1. Основні дані (Мова, переклади, конфіг)
app.use(async (req, res, next) => {
    const lang = req.query.lang || req.cookies?.lang || req.session?.lang || "pl";
    if (req.session) req.session.lang = lang;

    res.locals.lang = lang;
    // Якщо файлу перекладів немає, беремо пустий об'єкт, щоб не впало
    res.locals.t = (translations && translations[lang]) ? translations[lang] : (translations?.pl || {});
    res.locals.user = req.session.user || null;
    res.locals.requestPath = req.path;
    res.locals.query = req.query;

    // ЗАПАСНІ ДАНІ (Щоб сайт не падав, якщо база тупить)
    const defaultUI = {
        labels: { city: "Miasto", type: "Typ", category: "Kategoria", rooms: "Pokoje", minPrice: "Cena od", maxPrice: "Cena do" },
        buttons: { filter: "Filtruj", add: "Dodaj ogłoszenie" }
    };
    const defaultDict = { cities: [], categories: [], propertyTypes: [], rooms: [], districts: [] };

    try {
        // Пробуємо взяти з бази
        const config = await Settings.findOne({ key: "main_config" });
        
        if (config) {
            // Якщо в базі є UI, беремо його, інакше - запасний
            res.locals.ui = config.ui || defaultUI;
            
            // Фільтруємо словники
            res.locals.DICT = {
                cities: config.dictionary?.cities?.filter(c => c.enabled).map(c => c.name) || [],
                categories: config.dictionary?.categories?.filter(c => c.enabled).map(c => c.name) || [],
                propertyTypes: config.dictionary?.propertyTypes?.filter(c => c.enabled).map(c => c.name) || [],
                rooms: config.dictionary?.rooms?.filter(c => c.enabled).map(c => c.name) || [],
                districts: config.dictionary?.districts?.filter(c => c.enabled).map(c => c.name) || []
            };
        } else {
            console.log("⚠️ Config not found in DB, using defaults");
            res.locals.ui = defaultUI;
            res.locals.DICT = defaultDict;
        }
    } catch (e) {
        console.error("❌ Config load error:", e);
        // Якщо база впала - все одно показуємо сайт на запасних даних
        res.locals.ui = defaultUI;
        res.locals.DICT = defaultDict;
    }
    next();
});

// 2. Улюблені (З бази даних)
app.use(async (req, res, next) => {
    let favs = [];
    if (req.session.user) {
        const dbUser = await User.findOne({ username: req.session.user.username });
        if (dbUser) favs = dbUser.favorites || [];
    } else {
        favs = req.session.favorites || [];
    }
    res.locals.favorites = favs;
    next();
});

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect("/login");
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === "admin") return next();
    res.send("Brak uprawnień — tylko administrator.");
}

// --- ROUTES ---

// HOME
app.get("/", async (req, res) => {
    // 3 останні оголошення
    const latestOffers = await Offer.find({ status: 'active' })
        .sort({ createdAt: -1 })
        .limit(3);
    
    // Контент сторінки
    const page = await Page.findOne({ key: "home" });
    const content = page?.[res.locals.lang] || {};

    res.render("index", {
        content,
        latestOffers,
        requestPath: req.path,
        user: req.session.user
    });
});

app.get("/change-lang/:lang", (req, res) => {
    const { lang } = req.params;
    res.cookie("lang", lang, { maxAge: 1000 * 60 * 60 * 24 * 30 });
    if (req.session) req.session.lang = lang;
    res.redirect(req.get("Referer") || "/");
});

// FAVORITES
app.post("/favorites/toggle-ajax", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ success: false });

    let isAdded = false;
    if (req.session.user) {
        const user = await User.findOne({ username: req.session.user.username });
        if (user) {
            const idx = user.favorites.indexOf(id);
            if (idx === -1) { user.favorites.push(id); isAdded = true; }
            else { user.favorites.splice(idx, 1); isAdded = false; }
            await user.save();
        }
    } else {
        if (!req.session.favorites) req.session.favorites = [];
        const idx = req.session.favorites.indexOf(id);
        if (idx === -1) { req.session.favorites.push(id); isAdded = true; }
        else { req.session.favorites.splice(idx, 1); isAdded = false; }
    }
    res.json({ success: true, isAdded });
});

app.get("/favorites", async (req, res) => {
    let favIds = [];
    if (req.session.user) {
        const u = await User.findOne({ username: req.session.user.username });
        favIds = u?.favorites || [];
    } else {
        favIds = req.session.favorites || [];
    }
    
    const favorites = await Offer.find({ id: { $in: favIds } });
    
    res.render("favorites", { 
        offers: favorites, 
        user: req.session.user,
        lang: res.locals.lang, 
        t: res.locals.t,
        ui: res.locals.ui,
        requestPath: req.path,
        favorites: favIds
    });
});

// OFFERS
app.get("/offers", async (req, res) => {
    const { city, minPrice, maxPrice, rooms, sort, category, type, search } = req.query;
    
    // Формуємо запит до бази MongoDB
    let query = { status: 'active' };
    
    if (city) query.city = city;
    if (type) query.type = type;
    if (category) query.category = category;
    if (rooms) query.rooms = Number(rooms);
    
    if (minPrice || maxPrice) {
        query.price = {};
        if (minPrice) query.price.$gte = Number(minPrice);
        if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    if (search && search.trim() !== "") {
        query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } }
        ];
    }

    let mongoQuery = Offer.find(query);

    if (sort === "price_asc") mongoQuery.sort({ price: 1 });
    else if (sort === "price_desc") mongoQuery.sort({ price: -1 });
    else if (sort === "date_new") mongoQuery.sort({ createdAt: -1 });
    else mongoQuery.sort({ createdAt: -1 }); // За замовчуванням нові

    const offers = await mongoQuery.exec();
    res.render("offers", { offers, user: req.session.user, req });
});

app.get("/offers/add", isAuthenticated, async (req, res) => {
    res.render("add-offer", { user: req.session.user, dict: res.locals.DICT, message: null });
});

app.post("/offers/add", isAuthenticated, upload.array("images", 10), async (req, res) => {
    const { title, description, price, city, district, area, rooms, type, category } = req.body;
    const imagePaths = (req.files || []).map(file => "/uploads/" + file.filename);

    const newOffer = new Offer({
        title, description, 
        price: Number(price), city, district, 
        area: Number(area), rooms: Number(rooms), 
        type, category,
        images: imagePaths,
        user: req.session.user.email
    });

    await newOffer.save();
    await addLog("add", req.session.user);
    res.redirect("/offers");
});

app.get("/offers/edit/:id", isAuthenticated, async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer || offer.user !== req.session.user.email) return res.send("Brak uprawnień");
    
    // Оскільки ми тепер беремо словник з res.locals.DICT, передаємо його
    const dictionary = { 
        cities: { values: res.locals.DICT.cities },
        categories: { values: res.locals.DICT.categories },
        propertyTypes: { values: res.locals.DICT.propertyTypes },
        rooms: { values: res.locals.DICT.rooms },
        districts: { values: res.locals.DICT.districts }
    };

    res.render("edit-offer", { user: req.session.user, offer, dictionary });
});

app.post("/offers/edit/:id", isAuthenticated, upload.array("images", 10), async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer || offer.user !== req.session.user.email) return res.redirect("/my-offers");

    offer.title = req.body.title;
    offer.description = req.body.description;
    offer.price = Number(req.body.price);
    offer.city = req.body.city;
    offer.district = req.body.district;
    offer.area = Number(req.body.area);
    offer.rooms = Number(req.body.rooms);
    offer.type = req.body.type;
    offer.category = req.body.category;
    if (req.body.status) offer.status = req.body.status;
    if (req.body.coverIndex) offer.coverIndex = Number(req.body.coverIndex);

    if (req.body.removeImages) {
        const toRemove = Array.isArray(req.body.removeImages) ? req.body.removeImages : [req.body.removeImages];
        toRemove.forEach(img => {
             const p = path.join(__dirname, "public", img);
             if (fs.existsSync(p)) fs.unlinkSync(p);
        });
        offer.images = offer.images.filter(img => !toRemove.includes(img));
    }

    if (req.files && req.files.length > 0) {
        for (const f of req.files) {
            const originalPath = path.join("public/uploads", f.filename);
            const newFilename = "resized-" + f.filename;
            const outputPath = path.join("public/uploads", newFilename);
            
            await sharp(originalPath).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(outputPath);
            fs.unlinkSync(originalPath);
            offer.images.push("/uploads/" + newFilename);
        }
    }

    await offer.save();
    await addLog("edit", req.session.user);
    res.redirect("/my-offers");
});

app.post("/offers/delete/:id", isAuthenticated, async (req, res) => {
    await Offer.deleteOne({ id: req.params.id });
    await addLog("delete", req.session.user);
    res.redirect("/my-offers");
});

app.get("/offers/:id", async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer) return res.send("Ogłoszenie nie istnieje");
    res.render("offer-details", { offer, user: req.session.user });
});

app.get("/dashboard", isAuthenticated, async (req, res) => {
    res.render("dashboard", { user: req.session.user });
});

app.get("/my-offers", isAuthenticated, async (req, res) => {
    const offers = await Offer.find({ user: req.session.user.email });
    res.render("my-offers", { offers, user: req.session.user, dict: {}, query: {} });
});

// ADMIN
app.get("/admin", isAuthenticated, isAdmin, async (req, res) => {
    const totalUsers = await User.countDocuments();
    const totalOffers = await Offer.countDocuments();
    const lastUsers = await User.find().sort({ createdAt: -1 }).limit(5);
    
    // Фільтрація логів
    const period = req.query.period || 'all';
    let dateFilter = {};
    const now = new Date();
    if (period === 'day') dateFilter = { time: { $gte: new Date(now - 24*60*60*1000) } };
    if (period === 'week') dateFilter = { time: { $gte: new Date(now - 7*24*60*60*1000) } };

    const logs = await Log.find(dateFilter).sort({ time: -1 });
    
    // Підрахунок
    const actionCounts = { add: 0, edit: 0, delete: 0 };
    logs.forEach(l => { if (actionCounts[l.action] !== undefined) actionCounts[l.action]++; });
    
    res.render("admin/dashboard", { 
        user: req.session.user, totalUsers, totalOffers, 
        lastLogs: logs.slice(0, 10), actionCounts, period, lastUsers 
    });
});

app.get("/admin/settings", isAuthenticated, isAdmin, async (req, res) => {
    const config = await Settings.findOne({ key: "main_config" });
    
    // Адаптуємо нову структуру бази під старий вигляд для шаблону
    // Шаблон чекає { enabled: true, values: ["..."] }
    // А в базі у нас [{name: "...", enabled: true}]
    
    const adaptDict = (list) => ({
        enabled: true, 
        values: list ? list.map(item => item.name) : []
    });

    const adaptedDictionary = {
        cities: adaptDict(config?.dictionary?.cities),
        categories: adaptDict(config?.dictionary?.categories),
        propertyTypes: adaptDict(config?.dictionary?.propertyTypes),
        rooms: adaptDict(config?.dictionary?.rooms),
        districts: adaptDict(config?.dictionary?.districts)
    };

    res.render("admin/settings", { 
        settings: config?.settings || {}, 
        dictionary: adaptedDictionary, 
        user: req.session.user, 
        message: null 
    });
});

app.post("/admin/dictionary/:key", isAuthenticated, isAdmin, async (req, res) => {
    const { key } = req.params; // cities, categories etc.
    const { enabled, values } = req.body;
    
    const config = await Settings.findOne({ key: "main_config" });
    if (config && config.dictionary[key]) {
        // 🔥 Тут логіка для викладача: якщо ми зберігаємо масив рядків з коми,
        // то перетворюємо їх назад в об'єкти з enabled: true
        // Але якщо викладач хоче саме редагувати enabled окремо, це потребує складнішої форми.
        // Для спрощення: беремо список рядків, робимо їх {name: val, enabled: true}
        const valuesArray = values.split(",").map(v => v.trim()).filter(Boolean);
        
        // Зберігаємо як список об'єктів
        config.dictionary[key] = valuesArray.map(name => ({ name, enabled: true }));
        
        // Поле enabled самого словника (увімкнути весь блок)
        // У вашій схемі це було всередині.
        // Для спрощення просто оновимо список.
        
        // ВАЖЛИВО: Оскільки в адмінці ви вводите текст через кому, 
        // ми просто перезаписуємо список, роблячи всі нові елементи активними.
        
        config.markModified('dictionary');
        await config.save();
    }
    res.redirect("/admin/settings");
});

// AUTH
app.get("/login", (req, res) => res.render("login", { message: "" }));

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.render("login", { message: "Nie ma takiego użytkownika." });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.render("login", { message: "Złe hasło." });

    req.session.user = { username: user.username, email: user.email, role: user.role };
    res.redirect("/");
});

app.get("/register", (req, res) => res.render("register", { message: "" }));

app.post("/register", async (req, res) => {
    const { username, password, email, phone } = req.body;
    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.render("register", { message: "Użytkownik istnieje" });

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");

    await User.create({ username, passwordHash, email, phone, verificationToken });

    // Send email logic (same as before)
    // ...
    
    res.render("login", { message: "Konto utworzone! Zaloguj się." });
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
});

// CONTACT
app.get("/contact", async (req, res) => {
    const page = await Page.findOne({ key: "contact" });
    const content = page?.[res.locals.lang] || {};
    res.render("contact", { content, message: "", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
});

app.post("/contact", async (req, res) => {
    // Та ж сама логіка з nodemailer...
    res.render("contact", { content: {}, message: "Wysłano!", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
});
// --- ДОДАТКОВІ МАРШРУТИ (Профіль та Про нас) ---

// Сторінка "Про нас"
app.get("/about", async (req, res) => {
    const page = await Page.findOne({ key: "about" });
    const content = page?.[res.locals.lang] || { heroTitle: "O nas", heroText: "Informacje o firmie..." };
    res.render("about", { content, ui: res.locals.ui, user: req.session.user, requestPath: req.path });
});

// Сторінка "Профіль"
app.get("/profile", isAuthenticated, async (req, res) => {
    const user = await User.findOne({ username: req.session.user.username });
    res.render("profile", { user, message: "" });
});

// Оновлення профілю
app.post("/profile/update", isAuthenticated, async (req, res) => {
    try {
        const user = await User.findOne({ username: req.session.user.username });
        if (user) {
            user.username = req.body.username;
            user.email = req.body.email;
            user.phone = req.body.phone;
            await user.save();
            
            // Оновлюємо сесію, щоб ім'я змінилося в шапці сайту одразу
            req.session.user = { ...req.session.user, username: user.username, email: user.email, role: user.role };
            
            res.render("profile", { user, message: "Zaktualizowano pomyślnie!" });
        }
    } catch (e) {
        console.error("Profile update error:", e);
        res.render("profile", { user: req.session.user, message: "Błąd: Email lub login już zajęty." });
    }
});
// =================== ADMIN ROUTES (Вставити перед app.listen) ===================

// --- 1. УПРАВЛІННЯ КОРИСТУВАЧАМИ ---
app.get("/admin/users", isAuthenticated, isAdmin, async (req, res) => {
    // Показуємо всіх, крім адмінів
    const users = await User.find({ role: { $ne: 'admin' } });
    res.render("admin/users", { users, search: "", page: 1, totalPages: 1 });
});

app.get("/admin/users/:email/edit", isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (!user || user.role === "admin") return res.redirect("/admin/users");
    res.render("admin/user-edit", { user });
});

app.post("/admin/users/:email/edit", isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (user && user.role !== "admin") {
        user.username = req.body.username;
        user.email = req.body.email; 
        user.phone = req.body.phone;
        await user.save();
    }
    res.redirect("/admin/users");
});

app.post("/admin/users/:email/delete", isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (user && user.role !== "admin") {
        await User.deleteOne({ email: req.params.email });
        // Видаляємо також оголошення цього користувача
        await Offer.deleteMany({ user: req.params.email });
    }
    res.redirect("/admin/users");
});

// --- 2. УПРАВЛІННЯ ОГОЛОШЕННЯМИ ---
app.get("/admin/offers", isAuthenticated, isAdmin, async (req, res) => {
    const offers = await Offer.find();
    res.render("admin/offers", { offers, page: 1, totalPages: 1, search: "" });
});

app.get("/admin/offers/:id/edit", isAuthenticated, isAdmin, async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer) return res.redirect("/admin/offers");
    
    // Формуємо словник для старого шаблону (щоб не ламався ejs)
    const dictionary = { 
        cities: { values: res.locals.DICT.cities },
        categories: { values: res.locals.DICT.categories },
        propertyTypes: { values: res.locals.DICT.propertyTypes },
        rooms: { values: res.locals.DICT.rooms },
        districts: { values: res.locals.DICT.districts }
    };
    
    res.render("admin/offer-edit", { offer, dictionary });
});

app.post("/admin/offers/:id/edit", isAuthenticated, isAdmin, upload.array("images", 10), async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer) return res.redirect("/admin/offers");

    offer.title = req.body.title;
    offer.description = req.body.description;
    offer.price = Number(req.body.price);
    offer.city = req.body.city;
    offer.district = req.body.district;
    offer.area = Number(req.body.area);
    offer.rooms = Number(req.body.rooms);
    offer.type = req.body.type;
    offer.category = req.body.category;
    if (req.body.status) offer.status = req.body.status;
    
    // Логіка видалення фото
    if (req.body.removeImages) {
        const toRemove = Array.isArray(req.body.removeImages) ? req.body.removeImages : [req.body.removeImages];
        toRemove.forEach(img => {
             const p = path.join(__dirname, "public", img);
             if (fs.existsSync(p)) fs.unlinkSync(p);
        });
        offer.images = offer.images.filter(img => !toRemove.includes(img));
    }

    // Логіка додавання фото
    if (req.files && req.files.length > 0) {
        for (const f of req.files) {
            const originalPath = path.join("public/uploads", f.filename);
            const newFilename = "resized-" + f.filename;
            const outputPath = path.join("public/uploads", newFilename);
            await sharp(originalPath).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(outputPath);
            fs.unlinkSync(originalPath);
            offer.images.push("/uploads/" + newFilename);
        }
    }

    await offer.save();
    res.redirect("/admin/offers");
});

// --- 3. РЕДАГУВАННЯ СТОРІНОК (CMS) ---
app.get("/admin/pages/:pageKey", isAuthenticated, isAdmin, async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';
    
    const page = await Page.findOne({ key: pageKey });
    // Якщо сторінки немає в базі - даємо пустий об'єкт, щоб не впало
    const content = page?.[lang] || { heroTitle: "", heroText: "", sections: [], heroImages: [] };
    
    res.render("admin-page-editor", { pageKey, page: content, lang });
});

app.post('/admin/pages/:pageKey', isAuthenticated, isAdmin, upload.array('heroImages', 5), async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';

    // Знаходимо або створюємо сторінку
    let page = await Page.findOne({ key: pageKey });
    if (!page) page = new Page({ key: pageKey, pl: {}, en: {}, ua: {} });

    // Отримуємо існуючі дані
    const currentData = page[lang] || {};
    let finalImages = currentData.heroImages || [];
    if (req.body.clearHeroImages === "on") finalImages = [];

    // Додаємо нові фото
    if (req.files && req.files.length > 0) {
        for (const f of req.files) {
            const originalPath = path.join("public/uploads", f.filename);
            const newFilename = "hero-" + f.filename;
            const outputPath = path.join("public/uploads", newFilename);
            await sharp(originalPath).resize({ width: 1920 }).jpeg({ quality: 85 }).toFile(outputPath);
            fs.unlinkSync(originalPath);
            finalImages.push("/uploads/" + newFilename);
        }
    }

    // Оновлюємо об'єкт мови
    page[lang] = {
        heroTitle: req.body.heroTitle,
        heroText: req.body.heroText,
        sections: req.body.sections || [],
        heroImages: finalImages
    };

    // Mongoose вимагає повідомити, що поле Object змінилося
    page.markModified(lang); 
    await page.save();
    
    res.redirect(`/admin/pages/${pageKey}?lang=${lang}`);
});
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
