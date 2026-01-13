// ✅ ВСТАВТЕ СЮДИ ВАШ ПАРОЛЬ ЗАМІСТЬ <db_password>
const uri = "mongodb+srv://sofiazhovnik11:sofia123@clustertodo.edvhc5c.mongodb.net/test?appName=ClusterToDo";

import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { nanoid } from "nanoid";
import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { translations } from './translations.js';
import cookieParser from "cookie-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= MONGOOSE SCHEMAS =================

const userSchema = new mongoose.Schema({
  username: String,
  email: { type: String, unique: true },
  phone: String,
  passwordHash: String,
  role: { type: String, default: "user" },
  emailVerified: { type: Boolean, default: false },
  verificationToken: String,
  resetToken: String,
  resetTokenExpires: Date,
  favorites: [String]
});
const User = mongoose.model("User", userSchema);

const offerSchema = new mongoose.Schema({
  id: String,
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
  createdAt: { type: Date, default: Date.now },
  user: String
});
const Offer = mongoose.model("Offer", offerSchema);

const logSchema = new mongoose.Schema({
  action: String,
  user: String,
  time: { type: Date, default: Date.now }
});
const Log = mongoose.model("Log", logSchema);

const globalSettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  pages: Object,
  ui: Object,
  dictionary: Object,
  settings: Object
});
const GlobalSettings = mongoose.model("GlobalSettings", globalSettingsSchema);

// ================= СТАРТ СЕРВЕРА =================

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  try {
    await mongoose.connect(uri);
    console.log("✅ Підключено до MongoDB Atlas!");
    
    // 1. Ініціалізація налаштувань (якщо база пуста)
    const configExists = await GlobalSettings.findOne({ key: "main_config" });
    if (!configExists) {
        console.log("⚡ Ініціалізація налаштувань...");
        await GlobalSettings.create({
            key: "main_config",
            pages: {},
            ui: {
                pl: { menu: {}, buttons: {} },
                en: { menu: {}, buttons: {} },
                ua: { menu: {}, buttons: {} }
            },
            dictionary: {
                categories: { enabled: true, values: ["sprzedaż", "wynajem", "zamiana"] },
                cities: { enabled: true, values: ["Warszawa", "Kraków", "Poznań", "Gdańsk", "Wrocław"] },
                propertyTypes: { enabled: true, values: ["Mieszkanie", "Dom", "Kawalerka", "Lokal użytkowy"] },
                rooms: { enabled: true, values: ["1", "2", "3", "4", "5+"] },
                districts: { enabled: true, values: ["Centrum", "Mokotów", "Wola", "Praga"] }
            },
            settings: { currency: "PLN" }
        });
    }

    // 2. 🔥 АВТОМАТИЧНЕ СТВОРЕННЯ АДМІНА (Щоб ви могли зайти!)
    const adminExists = await User.findOne({ role: "admin" });
    if (!adminExists) {
        console.log("⚡ Створення користувача ADMIN...");
        const hashed = await bcrypt.hash("admin123", 10);
        await User.create({
            username: "Admin",
            email: "admin@realestate.com", // Можна використовувати для входу
            passwordHash: hashed,
            role: "admin", // 👈 Найголовніше
            emailVerified: true,
            phone: "+48000000000"
        });
        console.log("✅ Адмін створений! Логін: Admin, Пароль: admin123");
    }

  } catch (err) {
    console.error("❌ Помилка підключення до БД:", err);
    process.exit(1);
  }

  // Логування
  async function addLog(action, userObj) {
      await Log.create({
          action,
          user: userObj?.email || userObj?.username || "system"
      });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "sofiazhovnik11@gmail.com",
      pass: process.env.EMAIL_PASSWORD || "mfgt btgt oroz bxfz"
    }
  });

  // --- MULTER ---
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
      if (!file.mimetype.startsWith("image/")) {
        return cb(new Error("Tylko pliki graficzne"));
      }
      cb(null, true);
    }
  });

  // --- EXPRESS SETUP ---
  app.set("view engine", "ejs");
  app.use(express.static("public"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  
  app.use(
    session({
      secret: "supersecretkey",
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({ mongoUrl: uri }),
      cookie: { maxAge: 1000 * 60 * 60 * 24 }
    })
  );

  // ================= MIDDLEWARES =================

  app.use(async (req, res, next) => {
    const lang = req.query.lang || req.cookies?.lang || req.session?.lang || "pl";
    if (req.session) req.session.lang = lang;

    const globalConfig = await GlobalSettings.findOne({ key: "main_config" });
    const configData = globalConfig || { pages: {}, ui: {}, dictionary: {} };

    res.locals.lang = lang;
    res.locals.t = translations[lang] || translations.pl;
    res.locals.ui = configData.ui?.[lang] || {};
    res.locals.pages = configData.pages || {};
    res.locals.settings = configData.settings || {};
    res.locals.user = req.session.user || null;
    res.locals.requestPath = req.path;
    res.locals.query = req.query; 
    
    req.dict = configData.dictionary || {};
    next();
  });

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

  app.use((req, res, next) => {
    const dict = req.dict;
    res.locals.DICT = {
      categories: dict.categories?.enabled ? dict.categories.values : [],
      cities: dict.cities?.enabled ? dict.cities.values : [],
      propertyTypes: dict.propertyTypes?.enabled ? dict.propertyTypes.values : [],
      rooms: dict.rooms?.enabled ? dict.rooms.values : [],
      districts: dict.districts?.enabled ? dict.districts.values : []
    };
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

  // ==================== ROUTES ====================

 app.get("/", async (req, res) => {
  const lang = res.locals.lang;
  const latestOffers = await Offer.find({ status: 'active' }).sort({ createdAt: -1 }).limit(3);
  res.render("index", {
    content: res.locals.pages.home?.[lang] || {},
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
  
  // Favorites Logic
  app.post("/favorites/toggle-ajax", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ success: false });
    let isAdded = false;

    if (req.session.user) {
      const user = await User.findOne({ username: req.session.user.username });
      if (user) {
        if (user.favorites.includes(id)) {
            await User.updateOne({ _id: user._id }, { $pull: { favorites: id } });
            isAdded = false;
        } else {
            await User.updateOne({ _id: user._id }, { $addToSet: { favorites: id } });
            isAdded = true;
        }
      }
    } else {
      if (!req.session.favorites) req.session.favorites = [];
      const idx = req.session.favorites.indexOf(id);
      if (idx === -1) { req.session.favorites.push(id); isAdded = true; } 
      else { req.session.favorites.splice(idx, 1); isAdded = false; }
    }
    res.json({ success: true, isAdded });
  });

  app.get("/favorites/toggle/:id", async (req, res) => {
    const { id } = req.params;
    if (req.session.user) {
        const user = await User.findOne({ username: req.session.user.username });
        if (user) {
            if (user.favorites.includes(id)) {
                await User.updateOne({ _id: user._id }, { $pull: { favorites: id } });
            } else {
                await User.updateOne({ _id: user._id }, { $addToSet: { favorites: id } });
            }
        }
    } else {
        if (!req.session.favorites) req.session.favorites = [];
        const idx = req.session.favorites.indexOf(id);
        if (idx === -1) req.session.favorites.push(id);
        else req.session.favorites.splice(idx, 1);
    }
    res.redirect(req.get("Referer") || "/offers");
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

  app.get("/offers", async (req, res) => {
    const { city, minPrice, maxPrice, rooms, sort, category, type, search } = req.query;
    let query = { status: 'active' };

    if (city) query.city = city;
    if (type) query.type = type;
    if (category) query.category = category;
    if (rooms) query.rooms = rooms;
    
    if (minPrice || maxPrice) {
        query.price = {};
        if (minPrice) query.price.$gte = Number(minPrice);
        if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    
    if (search && search.trim() !== "") {
        const regex = new RegExp(search, 'i');
        query.$or = [{ title: regex }, { description: regex }];
    }

    let sortOption = {};
    if (sort === "price_asc") sortOption = { price: 1 };
    else if (sort === "price_desc") sortOption = { price: -1 };
    else if (sort === "date_new") sortOption = { createdAt: -1 };

    const offers = await Offer.find(query).sort(sortOption);
    res.render("offers", { offers, user: req.session.user, req });
  });

  app.get("/offers/add", isAuthenticated, async (req, res) => {
    res.render("add-offer", { user: req.session.user, dict: req.dict, message: null });
  });

  app.post("/offers/add", isAuthenticated, upload.array("images", 10), async (req, res) => {
    const { title, description, price, city, district, area, rooms, type, category } = req.body;
    const imagePaths = (req.files || []).map(file => "/uploads/" + file.filename);

    await Offer.create({
      id: nanoid(),
      title, description, 
      price: Number(price), city, district, 
      area: Number(area), rooms: Number(rooms), 
      type, category,
      images: imagePaths,
      coverIndex: 0,
      status: 'active',
      user: req.session.user.email
    });

    await addLog("add", req.session.user);
    res.redirect("/offers");
  });

  app.get("/offers/edit/:id", isAuthenticated, async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer || offer.user !== req.session.user.email) return res.send("Brak uprawnień");
    res.render("edit-offer", { user: req.session.user, offer, dictionary: req.dict });
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
    offer.status = req.body.status || 'active';
    
    if (req.body.coverIndex !== undefined) offer.coverIndex = Number(req.body.coverIndex);

    if (req.body.removeImages) {
       const toRemove = Array.isArray(req.body.removeImages) ? req.body.removeImages : [req.body.removeImages];
       toRemove.forEach(img => {
          const p = path.join(__dirname, "public", img);
          if (fs.existsSync(p)) fs.unlinkSync(p);
       });
       offer.images = offer.images.filter(img => !toRemove.includes(img));
    }

    if (req.files && req.files.length > 0) {
       const uploadDir = path.join(__dirname, "public/uploads");
       for (const f of req.files) {
           const originalPath = path.join(uploadDir, f.filename);
           const newFilename = "resized-" + f.filename;
           const outputPath = path.join(uploadDir, newFilename);
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
    const offer = await Offer.findOne({ id: req.params.id });
    if(offer && offer.user === req.session.user.email) {
        await Offer.deleteOne({ id: req.params.id });
        await addLog("delete", req.session.user);
    }
    res.redirect("/my-offers");
  });

  app.get("/offers/:id", async (req, res) => {
    const offer = await Offer.findOne({ id: req.params.id });
    if (!offer) return res.send("Ogłoszenie nie istnieje");
    res.render("offer-details", { offer, user: req.session.user });
  });

  app.get("/dashboard", isAuthenticated, async (req, res) => {
    const user = await User.findOne({ username: req.session.user.username });
    res.render("dashboard", { user: user || req.session.user });
  });

  app.get("/my-offers", isAuthenticated, async (req, res) => {
    const offers = await Offer.find({ user: req.session.user.email });
    res.render("my-offers", { offers, user: req.session.user, dict: req.dict, query: {} });
  });

  app.get("/profile", isAuthenticated, async (req, res) => {
    const user = await User.findOne({ username: req.session.user.username });
    res.render("profile", { user: user || req.session.user, message: "" });
  });

  app.post("/profile/update", isAuthenticated, async (req, res) => {
    const user = await User.findOne({ username: req.session.user.username });
    if (!user) return res.send("Error");
    user.username = req.body.username;
    user.email = req.body.email;
    user.phone = req.body.phone;
    await user.save();
    req.session.user = { username: user.username, email: user.email, role: user.role };
    res.render("profile", { user, message: "Zaktualizowano!" });
  });

  // Admin Routes
  app.get("/admin", isAuthenticated, isAdmin, async (req, res) => {
     const totalUsers = await User.countDocuments();
     const totalOffers = await Offer.countDocuments();
     const lastUsers = await User.find().sort({_id: -1}).limit(5);
     
     const period = req.query.period || 'all';
     let dateFilter = {};
     const now = new Date();
     
     if (period === 'day') dateFilter = { time: { $gte: new Date(now - 24 * 60 * 60 * 1000) } };
     else if (period === 'week') dateFilter = { time: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } };
     else if (period === 'month') dateFilter = { time: { $gte: new Date(now - 30 * 24 * 60 * 60 * 1000) } };

     const logs = await Log.find(dateFilter);
     const actionCounts = { add: 0, edit: 0, delete: 0 };
     logs.forEach(l => { if (actionCounts[l.action] !== undefined) actionCounts[l.action]++; });
     const lastLogs = await Log.find().sort({time: -1}).limit(10);

     res.render("admin/dashboard", { 
         user: req.session.user, totalUsers, totalOffers, lastLogs, actionCounts, period, lastUsers 
     });
  });

  app.get("/admin/users", isAuthenticated, isAdmin, async (req, res) => {
     const users = await User.find({ role: { $ne: "admin" } });
     res.render("admin/users", { users, search: "", page: 1, totalPages: 1 });
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
  
  app.get("/admin/users/:email/edit", isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (!user || user.role === "admin") return res.redirect("/admin/users");
    res.render("admin/user-edit", { user });
  });

 app.post("/admin/users/:email/delete", isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (user && user.role !== "admin") {
        await User.deleteOne({ email: req.params.email });
        await Offer.deleteMany({ user: req.params.email });
    }
    res.redirect("/admin/users");
  });

  app.get("/admin/offers", isAuthenticated, isAdmin, async (req, res) => {
    const offers = await Offer.find();
    res.render("admin/offers", { offers, page: 1, totalPages: 1, search: "" });
  });

 app.get("/admin/offers/:id/edit", isAuthenticated, isAdmin, async (req, res) => {
     const offer = await Offer.findOne({ id: req.params.id });
     if (!offer) return res.redirect("/admin/offers");
     res.render("admin/offer-edit", { offer });
  });
  
 app.get("/admin/settings", isAuthenticated, isAdmin, async (req, res) => {
    res.render("admin/settings", { 
        settings: res.locals.settings, dictionary: req.dict, user: req.session.user, message: null 
    });
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
    offer.status = req.body.status || 'active';

    if (req.body.removeImages) {
       const toRemove = Array.isArray(req.body.removeImages) ? req.body.removeImages : [req.body.removeImages];
       offer.images = offer.images.filter(img => !toRemove.includes(img));
    }

    if (req.files && req.files.length > 0) {
        const uploadDir = path.join(__dirname, "public/uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        for (const f of req.files) {
            const newFilename = "resized-" + f.filename;
            await sharp(f.path).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(path.join(uploadDir, newFilename));
            fs.unlinkSync(f.path);
            offer.images.push("/uploads/" + newFilename);
        }
    }

    await offer.save();
    res.redirect("/admin/offers");
  });

 app.post("/admin/settings", isAuthenticated, isAdmin, async (req, res) => {
    await GlobalSettings.updateOne({ key: "main_config" }, { $set: { settings: req.body } });
    res.redirect("/admin/settings");
  });

  app.get("/admin/pages/:pageKey", isAuthenticated, isAdmin, async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';
    const content = res.locals.pages[pageKey]?.[lang] || { heroTitle: "", heroText: "", sections: [], heroImages: [] };
    res.render("admin-page-editor", { pageKey, page: content, lang });
  });

  app.post('/admin/pages/:pageKey', isAuthenticated, isAdmin, upload.array('heroImages', 5), async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';
    const config = await GlobalSettings.findOne({ key: "main_config" });
    const pages = config.pages || {};
    const existingContent = pages[pageKey]?.[lang] || {};
    
    let finalImages = existingContent.heroImages || [];
    if (req.body.clearHeroImages === "on") finalImages = [];

    if (req.files && req.files.length > 0) {
        const uploadDir = path.join(__dirname, "public/uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        for (const f of req.files) {
            const newFilename = "hero-" + f.filename;
            await sharp(f.path).resize({ width: 1920, height: 800, fit: 'cover', position: 'center' }).jpeg({ quality: 85 }).toFile(path.join(uploadDir, newFilename));
            fs.unlinkSync(f.path);
            finalImages.push("/uploads/" + newFilename);
        }
    }

    const pageData = {
      heroTitle: req.body.heroTitle,
      heroText: req.body.heroText,
      sections: req.body.sections || [],
      heroImages: finalImages
    };

    const updateField = `pages.${pageKey}.${lang}`;
    await GlobalSettings.updateOne({ key: "main_config" }, { $set: { [updateField]: pageData } });
    res.redirect(`/admin/pages/${pageKey}?lang=${lang}`);
  });

  app.post("/admin/dictionary/:key", isAuthenticated, isAdmin, async (req, res) => {
    const { key } = req.params;
    const { enabled, values } = req.body;
    const valueArray = values.split(",").map(v => v.trim()).filter(Boolean);
    const updateField = `dictionary.${key}`;
    await GlobalSettings.updateOne({ key: "main_config" }, { 
        $set: { 
            [`${updateField}.enabled`]: (enabled === "on"),
            [`${updateField}.values`]: valueArray
        } 
    });
    res.redirect("/admin/settings");
  });

  // Auth Routes
  app.get("/login", (req, res) => res.render("login", { message: "" }));
  
  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    // Шукаємо або по username, або по email (щоб адмін міг зайти)
    const user = await User.findOne({ 
        $or: [{ username }, { email: username }] 
    });
    
    if (!user) return res.render("login", { message: "Nie ma takiego użytkownika." });

    let match = false;
    if (user.passwordHash && user.passwordHash.startsWith("$2")) {
      match = await bcrypt.compare(password, user.passwordHash);
    } else {
      match = password === user.passwordHash;
    }

    if (!match) return res.render("login", { message: "Złe hasło." });

    req.session.user = { username: user.username, email: user.email, role: user.role };
    res.redirect("/");
  });

  app.get("/register", (req, res) => res.render("register", { message: "" }));

  app.post("/register", async (req, res) => {
    const { username, password, email, phone } = req.body;
    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.render("register", { message: "Użytkownik lub email już istnieje" });

    const hashed = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");

    await User.create({
      username, passwordHash: hashed, email, phone,
      emailVerified: false, verificationToken, role: "user"
    });

    try {
      await transporter.sendMail({
        from: "RealEstateCMS", to: email, subject: "Potwierdzenie",
        text: `Link: http://localhost:${PORT}/verify/${verificationToken}`
      });
    } catch (e) { console.log(e); }
    res.render("login", { message: "Sprawdź email!" });
  });

  app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

  app.get("/verify/:token", async (req, res) => {
     const user = await User.findOne({ verificationToken: req.params.token });
     if (user) {
         user.emailVerified = true;
         user.verificationToken = null;
         await user.save();
     }
     res.render("login", { message: "Email potwierdzony" });
  });

  app.get("/forgot-password", (req, res) => res.render("forgot-password", { message: "" }));
  app.post("/forgot-password", async (req, res) => {
      const { email } = req.body;
      const user = await User.findOne({ email });
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        user.resetToken = token;
        user.resetTokenExpires = Date.now() + 3600000; 
        await user.save();
        try {
          await transporter.sendMail({
            from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
            to: email, subject: "Resetowanie hasła",
            text: `Kliknij w link, aby zresetować hasło: http://localhost:3000/reset-password/${token}`
          });
        } catch (e) { console.error(e); }
      }
      res.render("forgot-password", { message: "Jeśli taki email istnieje, wysłaliśmy link." });
  });
  
  app.get("/reset-password/:token", (req, res) => res.render("reset-password", { token: req.params.token, message: "" }));
  app.post("/reset-password/:token", async (req, res) => {
      const { password } = req.body;
      const token = req.params.token;
      const user = await User.findOne({ 
          resetToken: token, resetTokenExpires: { $gt: Date.now() } 
      });
      if (!user) return res.render("login", { message: "Link wygasł lub jest nieprawidłowy." });

      const hashed = await bcrypt.hash(password, 10);
      user.passwordHash = hashed;
      user.resetToken = null;
      user.resetTokenExpires = null;
      await user.save();
      res.render("login", { message: "Hasło zostało pomyślnie zmienione. Zaloguj się." });
  });

  app.get("/about", async (req, res) => {
    const content = res.locals.pages.about?.[res.locals.lang] || { heroTitle: "", heroText: "" };
    res.render("about", { content, ui: res.locals.ui, user: req.session.user, requestPath: req.path });
  });

  app.get("/contact", async (req, res) => {
    const content = res.locals.pages.contact?.[res.locals.lang] || { heroTitle: "", heroText: "" };
    res.render("contact", { content, message: "", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
  });

  app.post("/contact", async (req, res) => {
     const { name, email, message } = req.body;
     try {
       await transporter.sendMail({
         from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
         to: "sofiazhovnik11@gmail.com",
         replyTo: email,
         subject: `Nowa wiadomość od: ${name}`,
         text: `Użytkownik: ${name} (${email})\nNapisał: ${message}`
       });
     } catch (e) { console.error(e); }
     res.render("contact", { content: {}, message: "Wysłano!", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
  });

  app.post("/contact/:id", async (req, res) => {
      const offer = await Offer.findOne({ id: req.params.id });
      if (offer) {
        const { name, email, message, phone } = req.body;
        const recipient = offer.user ? offer.user : "sofiazhovnik11@gmail.com";
        try {
          await transporter.sendMail({
            from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
            to: recipient, replyTo: email,
            subject: `Pytanie o ogłoszenie: ${offer.title}`,
            text: `Witaj!\n\nUżytkownik ${name} interesuje się Twoim ogłoszeniem "${offer.title}".\n\nWiadomość:\n${message}\n\nKontakt do zainteresowanego:\nEmail: ${email}\nTelefon: ${phone || "Brak"}\n\nLink do ogłoszenia: http://localhost:3000/offers/${offer.id}`
          });
        } catch (e) { console.error(e); }
      }
      res.render("offer-details", { offer, user: req.session.user, success: "Wysłano!" });
  });

  app.use((req, res) => {
      res.status(404).send("Strona nie znaleziona (404)");
  });

  app.listen(PORT, () => {
    console.log(`Server działa na http://localhost:${PORT}`);
  });
}

startServer().catch(err => console.error(err));