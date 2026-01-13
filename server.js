import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
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

// ✅ 1. ОГОЛОШУЄМО ЗМІННУ DB ГЛОБАЛЬНО
let db;

// -------------------- Старт сервера --------------------
async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // ✅ 2. ІНІЦІАЛІЗАЦІЯ БАЗИ ДАНИХ
  const adapter = new JSONFile("db.json");
  const defaultData = { users: [], offers: [] };
  
  db = new Low(adapter, defaultData);
  await db.read();

  // Ініціалізація структури БД (якщо файл новий)
  db.data ||= {};
  db.data.users ||= [];
  db.data.offers ||= [];
  db.data.pages ||= {};
  db.data.ui ||= {
    pl: { menu: {}, buttons: {} },
    en: { menu: {}, buttons: {} },
    ua: { menu: {}, buttons: {} }
  };
  db.data.dictionary ||= {
    categories: { enabled: true, values: ["sprzedaż", "wynajem", "zamiana"] },
    cities: { enabled: true, values: ["Warszawa", "Kraków", "Poznań", "Gdańsk", "Wrocław"] },
    propertyTypes: { enabled: true, values: ["Mieszkanie", "Dom", "Kawalerka", "Lokal użytkowy"] },
    rooms: { enabled: true, values: ["1", "2", "3", "4", "5+"] },
    districts: { enabled: true, values: ["Centrum", "Mokotów", "Wola", "Praga"] }
  };

  await db.write();

  // Функція логування
  async function addLog(action, user) {
      db.data.logs ||= [];
      db.data.logs.push({
          action,
          user: user?.email || user?.username || "system",
          time: new Date().toISOString()
      });
      await db.write();
  }

  // ✅ 3. НАЛАШТУВАННЯ ПОШТИ
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "sofiazhovnik11@gmail.com",
      pass: "mfgt btgt oroz bxfz" // Ваш пароль додатка
    }
  });

  // --- MULTER (Завантаження файлів) ---
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = "public/uploads";
      if (!fs.existsSync(dir)){
          fs.mkdirSync(dir, { recursive: true });
      }
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
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
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
  app.use(express.json()); // ВАЖЛИВО для AJAX
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  
  app.use(
    session({
      secret: "supersecretkey",
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 день
    })
  );

  // ================= MIDDLEWARES =================

  // 1. Основні дані (Мова, переклади, користувач)
  app.use(async (req, res, next) => {
    await db.read();

    const lang = req.query.lang || req.cookies?.lang || req.session?.lang || "pl";
    if (req.session) {
      req.session.lang = lang;
    }

    res.locals.lang = lang;
    res.locals.t = translations[lang] || translations.pl;
    res.locals.ui = db.data.ui?.[lang] || {};
    res.locals.user = req.session.user || null;
    res.locals.requestPath = req.path;
    res.locals.query = req.query; 

    next();
  });

  // 2. Улюблені (Завантаження списку)
  app.use(async (req, res, next) => {
    let favs = [];
    if (req.session.user) {
      const dbUser = db.data.users.find(u => u.username === req.session.user.username);
      if (dbUser) favs = dbUser.favorites || [];
    } else {
      favs = req.session.favorites || [];
    }
    res.locals.favorites = favs;
    next();
  });

  // --- MIDDLEWARE ДЛЯ УЛЮБЛЕНИХ ---
app.use(async (req, res, next) => {
  let favs = [];
  if (req.session.user) {
    // Якщо користувач увійшов -> читаємо з бази
    const dbUser = db.data.users.find(u => u.username === req.session.user.username);
    if (dbUser) favs = dbUser.favorites || [];
  } else {
    // Якщо гість -> читаємо з сесії
    favs = req.session.favorites || [];
  }
  res.locals.favorites = favs;
  next();
});

  // 3. Словники (Dict)
  app.use((req, res, next) => {
    const dict = db.data.dictionary;
    res.locals.DICT = {
      categories: dict.categories?.enabled ? dict.categories.values : [],
      cities: dict.cities?.enabled ? dict.cities.values : [],
      propertyTypes: dict.propertyTypes?.enabled ? dict.propertyTypes.values : [],
      rooms: dict.rooms?.enabled ? dict.rooms.values : [],
      districts: dict.districts?.enabled ? dict.districts.values : []
    };
    next();
  });

  // --- AUTH FUNCTIONS ---
  function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect("/login");
  }

  function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === "admin") return next();
    res.send("Brak uprawnień — tylko administrator.");
  }

  // ==================== МАРШРУТИ (ROUTES) ====================

  // --- HOME PAGE ---
 app.get("/", async (req, res) => {
  await db.read();
  const lang = res.locals.lang;
  
  // 👇 ЦЕ НОВЕ: Беремо 3 останні оголошення
  const latestOffers = db.data.offers
      .slice()       // Робимо копію
      .reverse()     // Розвертаємо (нові зверху)
      .slice(0, 3);  // Беремо перші 3

  res.render("index", {
    content: db.data.pages.home?.[lang],
    latestOffers, // 👈 Передаємо у шаблон
    requestPath: req.path,
    user: req.session.user
  });
});

  // --- CHANGE LANGUAGE ---
  app.get("/change-lang/:lang", (req, res) => {
    const { lang } = req.params;
    res.cookie("lang", lang, { maxAge: 1000 * 60 * 60 * 24 * 30 });
    if (req.session) req.session.lang = lang;
    res.redirect(req.get("Referer") || "/");
  });

  // --- FAVORITES (УЛЮБЛЕНІ) ---
  
  // 1. AJAX Toggle
  app.post("/favorites/toggle-ajax", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ success: false });

    await db.read();
    let isAdded = false;

    if (req.session.user) {
      const userIndex = db.data.users.findIndex(u => u.username === req.session.user.username);
      if (userIndex !== -1) {
        const user = db.data.users[userIndex];
        if (!user.favorites) user.favorites = [];
        const idx = user.favorites.indexOf(id);
        
        if (idx === -1) { user.favorites.push(id); isAdded = true; } 
        else { user.favorites.splice(idx, 1); isAdded = false; }
        
        await db.write();
      }
    } else {
      if (!req.session.favorites) req.session.favorites = [];
      const idx = req.session.favorites.indexOf(id);
      
      if (idx === -1) { req.session.favorites.push(id); isAdded = true; } 
      else { req.session.favorites.splice(idx, 1); isAdded = false; }
    }
    res.json({ success: true, isAdded });
  });

  // 2. GET Toggle (Fallback)
  app.get("/favorites/toggle/:id", async (req, res) => {
    const { id } = req.params;
    await db.read();

    if (req.session.user) {
        const user = db.data.users.find(u => u.username === req.session.user.username);
        if (user) {
            if (!user.favorites) user.favorites = [];
            const idx = user.favorites.indexOf(id);
            if (idx === -1) user.favorites.push(id);
            else user.favorites.splice(idx, 1);
            await db.write();
        }
    } else {
        if (!req.session.favorites) req.session.favorites = [];
        const idx = req.session.favorites.indexOf(id);
        if (idx === -1) req.session.favorites.push(id);
        else req.session.favorites.splice(idx, 1);
    }
    res.redirect(req.get("Referer") || "/offers");
  });

  // 3. Page
  app.get("/favorites", async (req, res) => {
    await db.read();
    
    let favIds = [];
    if (req.session.user) {
       const u = db.data.users.find(u => u.username === req.session.user.username);
       favIds = u?.favorites || [];
    } else {
       favIds = req.session.favorites || [];
    }
    
    const favorites = db.data.offers.filter(o => favIds.includes(o.id));
    
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

  // --- OFFERS ---
  app.get("/offers", (req, res) => {
    let offers = [...db.data.offers];
    const { city, minPrice, maxPrice, rooms, sort, category, type, search } = req.query;

    if (city) offers = offers.filter(o => o.city === city);
    if (type) offers = offers.filter(o => o.type === type);
    if (category) offers = offers.filter(o => o.category === category);
    if (minPrice) offers = offers.filter(o => o.price >= Number(minPrice));
    if (maxPrice) offers = offers.filter(o => o.price <= Number(maxPrice));
    if (rooms) offers = offers.filter(o => o.rooms == Number(rooms));
    
    if (search && search.trim() !== "") {
        const s = search.toLowerCase();
        offers = offers.filter(o => 
            (o.title || "").toLowerCase().includes(s) || 
            (o.description || "").toLowerCase().includes(s)
        );
    }

    if (sort === "price_asc") offers.sort((a, b) => a.price - b.price);
    if (sort === "price_desc") offers.sort((a, b) => b.price - a.price);
    if (sort === "date_new") offers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.render("offers", { offers, user: req.session.user, req });
  });
    // --- ADD / EDIT OFFERS ---
  app.get("/offers/add", isAuthenticated, async (req, res) => {
    res.render("add-offer", { user: req.session.user, dict: db.data.dictionary, message: null });
  });

  app.post("/offers/add", isAuthenticated, upload.array("images", 10), async (req, res) => {
    await db.read();
    const { title, description, price, city, district, area, rooms, type, category } = req.body;

    const imagePaths = (req.files || []).map(file => "/uploads/" + file.filename);

    db.data.offers.push({
      id: nanoid(),
      title, description, 
      price: Number(price), city, district, 
      area: Number(area), rooms: Number(rooms), 
      type, category,
      images: imagePaths,
      coverIndex: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      user: req.session.user.email
    });

    await db.write();
    await addLog("add", req.session.user);
    res.redirect("/offers");
  });

  app.get("/offers/edit/:id", isAuthenticated, async (req, res) => {
    const offer = db.data.offers.find(o => o.id === req.params.id);
    if (!offer || offer.user !== req.session.user.email) return res.send("Brak uprawnień");
    res.render("edit-offer", { user: req.session.user, offer, dictionary: db.data.dictionary });
  });

  app.post("/offers/edit/:id", isAuthenticated, upload.array("images", 10), async (req, res) => {
    const offer = db.data.offers.find(o => o.id === req.params.id);
    if (!offer || offer.user !== req.session.user.email) return res.redirect("/my-offers");

    const { title, description, price, city, district, area, rooms, type, category, coverIndex, removeImages, imageOrder, status } = req.body;

    Object.assign(offer, {
      title: req.body.title,
      description: req.body.description,
      price: Number(req.body.price),
      city: req.body.city,
      district: req.body.district,
      area: Number(req.body.area),
      rooms: Number(req.body.rooms),
      type: req.body.type,
      category: req.body.category,
      status: req.body.status || 'active'
    });

    if (coverIndex !== undefined) offer.coverIndex = Number(coverIndex);

    if (removeImages) {
       const toRemove = Array.isArray(removeImages) ? removeImages : [removeImages];
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

            await sharp(originalPath)
                .resize({ width: 1200 })
                .jpeg({ quality: 80 })
                .toFile(outputPath);
            
            fs.unlinkSync(originalPath);
            offer.images.push("/uploads/" + newFilename);
        }
    }

    await db.write();
    await addLog("edit", req.session.user);
    res.redirect("/my-offers");
  });

  app.post("/offers/delete/:id", isAuthenticated, async (req, res) => {
    db.data.offers = db.data.offers.filter(o => o.id !== req.params.id);
    await db.write();
    await addLog("delete", req.session.user);
    res.redirect("/my-offers");
  });

  app.get("/offers/:id", (req, res) => {
    const offer = db.data.offers.find(o => o.id === req.params.id);
    if (!offer) return res.send("Ogłoszenie nie istnieje");
    res.render("offer-details", { offer, user: req.session.user });
  });

  // ✅ ПОВЕРНУТО МАРШРУТ DASHBOARD
  app.get("/dashboard", isAuthenticated, async (req, res) => {
    await db.read();
    const user = db.data.users.find(u => u.username === req.session.user.username) || req.session.user;
    res.render("dashboard", { user });
  });

  // --- MY OFFERS ---
  app.get("/my-offers", isAuthenticated, (req, res) => {
    const offers = db.data.offers.filter(o => o.user === req.session.user.email);
    res.render("my-offers", { offers, user: req.session.user, dict: db.data.dictionary, query: {} });
  });

  // --- PROFILE ---
  app.get("/profile", isAuthenticated, (req, res) => {
    const user = db.data.users.find(u => u.username === req.session.user.username) || req.session.user;
    res.render("profile", { user, message: "" });
  });

  app.post("/profile/update", isAuthenticated, async (req, res) => {
    const user = db.data.users.find(u => u.username === req.session.user.username);
    if (!user) return res.send("Error");
    user.username = req.body.username;
    user.email = req.body.email;
    user.phone = req.body.phone;
    await db.write();
    req.session.user = { username: user.username, email: user.email, role: user.role };
    res.render("profile", { user, message: "Zaktualizowano!" });
  });

// --- ADMIN PANEL (Зі статистикою) ---
  app.get("/admin", isAuthenticated, isAdmin, async (req, res) => {
     await db.read();
     
     const totalUsers = db.data.users.length;
     const totalOffers = db.data.offers.length;
     
     // 1. Останні користувачі (беремо 5 останніх)
     const lastUsers = db.data.users.slice().reverse().slice(0, 5);

     // 2. Логи (якщо їх немає, беремо пустий масив)
     const logs = db.data.logs || [];
     
     // 3. Фільтрація по періоду (день, тиждень, місяць)
     const period = req.query.period || 'all';
     let filteredLogs = logs;
     
     const now = new Date();
     if (period === 'day') {
         filteredLogs = logs.filter(l => (now - new Date(l.time)) < 24 * 60 * 60 * 1000);
     } else if (period === 'week') {
         filteredLogs = logs.filter(l => (now - new Date(l.time)) < 7 * 24 * 60 * 60 * 1000);
     } else if (period === 'month') {
         filteredLogs = logs.filter(l => (now - new Date(l.time)) < 30 * 24 * 60 * 60 * 1000);
     }

     // 4. Підрахунок дій для графіка (add, edit, delete)
     const actionCounts = { add: 0, edit: 0, delete: 0 };
     filteredLogs.forEach(l => {
         if (actionCounts[l.action] !== undefined) {
             actionCounts[l.action]++;
         }
     });

     // 5. Останні записи активності (для списку)
     const lastLogs = filteredLogs.slice().reverse().slice(0, 10);

     res.render("admin/dashboard", { 
         user: req.session.user, 
         totalUsers, 
         totalOffers, 
         lastLogs, 
         actionCounts, 
         period, 
         lastUsers 
     });
  });
app.get("/admin/users", isAuthenticated, isAdmin, (req, res) => {
     // Фільтруємо, щоб не показувати адмінів
     const users = db.data.users.filter(u => u.role !== "admin");
     res.render("admin/users", { users, search: "", page: 1, totalPages: 1 });
  });
  
 app.post("/admin/users/:email/edit", isAuthenticated, isAdmin, async (req, res) => {
    const user = db.data.users.find(u => u.email === req.params.email);
    if (user && user.role !== "admin") {
        user.username = req.body.username;
        user.email = req.body.email; // Тут обережно, бо email це ID
        user.phone = req.body.phone;
        await db.write();
    }
    res.redirect("/admin/users");
  });
  app.get("/admin/users/:email/edit", isAuthenticated, isAdmin, (req, res) => {
    const user = db.data.users.find(u => u.email === req.params.email);
    // Забороняємо редагувати адмінів або неіснуючих
    if (!user || user.role === "admin") return res.redirect("/admin/users");
    res.render("admin/user-edit", { user });
  });

 app.post("/admin/users/:email/delete", isAuthenticated, isAdmin, async (req, res) => {
    const user = db.data.users.find(u => u.email === req.params.email);
    // Не дозволяємо видалити адміна
    if (user && user.role !== "admin") {
        db.data.users = db.data.users.filter(u => u.email !== req.params.email);
        // Також видаляємо його оголошення
        db.data.offers = db.data.offers.filter(o => o.user !== req.params.email);
        await db.write();
    }
    res.redirect("/admin/users");
  });
  app.get("/admin/offers", isAuthenticated, isAdmin, (req, res) => {
    res.render("admin/offers", { offers: db.data.offers, page: 1, totalPages: 1, search: "" });
  });

 app.get("/admin/offers/:id/edit", isAuthenticated, isAdmin, (req, res) => {
     const offer = db.data.offers.find(o => o.id === req.params.id);
     if (!offer) return res.redirect("/admin/offers");
     // Тут ми НЕ перевіряємо власника, бо це адмін
     res.render("admin/offer-edit", { offer });
  });
  
 app.get("/admin/settings", isAuthenticated, isAdmin, async (req, res) => {
    res.render("admin/settings", { 
        settings: db.data.settings, 
        dictionary: db.data.dictionary, 
        user: req.session.user, 
        message: null 
    });
  });
 // --- ADMIN: EDIT OFFER (Виправлено помилку 'push') ---
  app.post("/admin/offers/:id/edit", isAuthenticated, isAdmin, upload.array("images", 10), async (req, res) => {
    const offer = db.data.offers.find(o => o.id === req.params.id);
    if (!offer) return res.redirect("/admin/offers");

    // ✅ 1. ГАРАНТУЄМО, ЩО images ІСНУЄ (Виправлення помилки 'push')
    if (!Array.isArray(offer.images)) {
        offer.images = [];
    }

    // Оновлюємо поля
    Object.assign(offer, {
      title: req.body.title,
      description: req.body.description,
      price: Number(req.body.price),
      city: req.body.city,
      district: req.body.district,
      area: Number(req.body.area),
      rooms: Number(req.body.rooms),
      type: req.body.type,
      category: req.body.category,
      status: req.body.status || 'active'
    });

    // Видалення фото
    if (req.body.removeImages) {
       const toRemove = Array.isArray(req.body.removeImages) ? req.body.removeImages : [req.body.removeImages];
       offer.images = offer.images.filter(img => !toRemove.includes(img));
    }

    // Додавання фото
    if (req.files && req.files.length > 0) {
        const uploadDir = path.join(__dirname, "public/uploads");
        
        // Переконуємось, що папка існує
        if (!fs.existsSync(uploadDir)) {
             fs.mkdirSync(uploadDir, { recursive: true });
        }

        for (const f of req.files) {
            const originalPath = path.join(uploadDir, f.filename);
            const newFilename = "resized-" + f.filename;
            const outputPath = path.join(uploadDir, newFilename);
            
            try {
                // FIX EPERM: Читаємо -> Обробляємо -> Видаляємо
                const buffer = fs.readFileSync(originalPath);
                await sharp(buffer).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(outputPath);
                
                if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
                
                // Тепер це безпечно, бо ми ініціалізували offer.images вище
                offer.images.push("/uploads/" + newFilename);
            } catch (e) {
                console.error("Помилка фото:", e);
            }
        }
    }

    await db.write();
    res.redirect("/admin/offers");
  });
 app.post("/admin/settings", isAuthenticated, isAdmin, async (req, res) => {
    db.data.settings = { ...db.data.settings, ...req.body };
    await db.write();
    res.redirect("/admin/settings");
  });

  app.get("/admin/pages/:pageKey", isAuthenticated, isAdmin, async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';
    await db.read();
    const page = db.data.pages?.[pageKey]?.[lang] || { heroTitle: "", heroText: "", sections: [], heroImages: [] };
    res.render("admin-page-editor", { pageKey, page, lang });
  });

  // --- ADMIN: PAGE EDITOR (ЗБЕРЕЖЕННЯ З ФОТО) ---
  app.post('/admin/pages/:pageKey', isAuthenticated, isAdmin, upload.array('heroImages', 5), async (req, res) => {
    const { pageKey } = req.params;
    const lang = req.query.lang || 'pl';
    
    await db.read();
    
    // 1. Безпечно отримуємо поточні дані сторінки
    // Якщо сторінки або мови немає - створюємо пусті об'єкти
    const pageEntry = db.data.pages[pageKey] || {};
    const existingContent = pageEntry[lang] || {};
    
    // 2. Перевіряємо масив фото. Якщо його немає або він поламаний - робимо пустим масивом []
    let finalImages = existingContent.heroImages;
    if (!Array.isArray(finalImages)) {
        finalImages = [];
    }

    // 3. Якщо натиснули "Видалити старі" - очищаємо
    if (req.body.clearHeroImages === "on") {
        finalImages = [];
    }

    // 4. Обробка нових фото
    if (req.files && req.files.length > 0) {
        const uploadDir = path.join(__dirname, "public/uploads");
        
        // Переконуємось, що папка існує
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        for (const f of req.files) {
            const originalPath = path.join(uploadDir, f.filename);
            const newFilename = "hero-" + f.filename;
            const outputPath = path.join(uploadDir, newFilename);

            try {
                // FIX EPERM: Читаємо буфер -> Sharp -> Видаляємо оригінал
                const buffer = fs.readFileSync(originalPath);
                
                await sharp(buffer)
                    .resize({ width: 1920, height: 800, fit: 'cover', position: 'center' }) 
                    .jpeg({ quality: 85 })
                    .toFile(outputPath);
                
                // Видаляємо тільки якщо файл існує і не заблокований
                if (fs.existsSync(originalPath)) {
                    fs.unlinkSync(originalPath);
                }

                // Додаємо шлях у масив (ТЕПЕР ЦЕ БЕЗПЕЧНО, БО finalImages ТОЧНО МАСИВ)
                finalImages.push("/uploads/" + newFilename);
            } catch (err) {
                console.error("Помилка обробки фото:", err);
            }
        }
    }

    // 5. Формуємо об'єкт для збереження
    const pageData = {
      heroTitle: req.body.heroTitle,
      heroText: req.body.heroText,
      sections: req.body.sections || [],
      heroImages: finalImages
    };

    // 6. Записуємо в базу
    if (!db.data.pages[pageKey]) db.data.pages[pageKey] = {};
    db.data.pages[pageKey][lang] = pageData;
    
    await db.write();
    
    res.redirect(`/admin/pages/${pageKey}?lang=${lang}`);
  });
app.post("/admin/dictionary/:key", isAuthenticated, isAdmin, async (req, res) => {
    const { key } = req.params;
    const { enabled, values } = req.body;
    
    // Перевіряємо, чи існує такий словник
    if (db.data.dictionary[key]) {
        db.data.dictionary[key].enabled = (enabled === "on");
        // Розбиваємо рядок через кому на масив
        db.data.dictionary[key].values = values.split(",").map(v => v.trim()).filter(Boolean);
        await db.write();
    }
    res.redirect("/admin/settings");
  });
  // --- AUTH ROUTES ---
  app.get("/login", (req, res) => res.render("login", { message: "" }));
  
  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const user = db.data.users.find(u => u.username === username);
    if (!user) return res.render("login", { message: "Nie ma takiego użytkownika." });

    let match = false;
    if (user.passwordHash && user.passwordHash.startsWith("$2")) {
      match = await bcrypt.compare(password, user.passwordHash);
    } else {
      match = password === user.passwordHash;
    }

    if (!match) return res.render("login", { message: "Złe hasło." });

    req.session.user = { username: user.username, email: user.email, role: user.role || "user" };
    res.redirect("/");
  });

  app.get("/register", (req, res) => res.render("register", { message: "" }));

  app.post("/register", async (req, res) => {
    const { username, password, email, phone } = req.body;
    if (db.data.users.find(u => u.username === username || u.email === email)) {
        return res.render("register", { message: "Użytkownik istnieje" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");

    db.data.users.push({
      username, passwordHash: hashed, email, phone,
      emailVerified: false, verificationToken, role: "user"
    });
    await db.write();

    try {
      await transporter.sendMail({
        from: "RealEstateCMS", to: email, subject: "Potwierdzenie",
        text: `Link: http://localhost:${PORT}/verify/${verificationToken}`
      });
    } catch (e) { console.log(e); }

    res.render("login", { message: "Sprawdź email!" });
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
  });

  app.get("/verify/:token", async (req, res) => {
     const user = db.data.users.find(u => u.verificationToken === req.params.token);
     if (user) {
         user.emailVerified = true;
         user.verificationToken = null;
         await db.write();
     }
     res.render("login", { message: "Email potwierdzony" });
  });

  app.get("/forgot-password", (req, res) => res.render("forgot-password", { message: "" }));
  app.post("/forgot-password", async (req, res) => {
      const { email } = req.body;
      const user = db.data.users.find(u => u.email === email);
      
      if (user) {
        // Генеруємо тимчасовий токен
        const token = crypto.randomBytes(32).toString("hex");
        user.resetToken = token;
        // Токен діє 1 годину
        user.resetTokenExpires = Date.now() + 3600000; 
        await db.write();

        try {
          await transporter.sendMail({
            from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
            to: email,
            subject: "Resetowanie hasła",
            text: `Kliknij w link, aby zresetować hasło: http://localhost:3000/reset-password/${token}`
          });
          console.log(`Wysłano link resetujący do: ${email}`);
        } catch (e) {
          console.error("Błąd wysyłania resetu:", e);
        }
      }

      // Завжди пишемо "Надіслано" з міркувань безпеки (щоб не виказувати, хто є в базі)
      res.render("forgot-password", { message: "Jeśli taki email istnieje, wysłaliśmy link." });
  });
  
  app.get("/reset-password/:token", (req, res) => res.render("reset-password", { token: req.params.token, message: "" }));
  app.post("/reset-password/:token", async (req, res) => {
      const { password } = req.body;
      const token = req.params.token;
      
      // Шукаємо користувача з таким токеном і щоб час не вийшов
      const user = db.data.users.find(u => u.resetToken === token && u.resetTokenExpires > Date.now());

      if (!user) {
        return res.render("login", { message: "Link wygasł lub jest nieprawidłowy." });
      }

      // Хешуємо новий пароль
      const hashed = await bcrypt.hash(password, 10);
      user.passwordHash = hashed;
      user.resetToken = null;
      user.resetTokenExpires = null;
      await db.write();

      res.render("login", { message: "Hasło zostało pomyślnie zmienione. Zaloguj się." });
  });

  // --- CONTACT ---
  app.get("/about", async (req, res) => {
    const content = db.data.pages.about?.[res.locals.lang] || { heroTitle: "", heroText: "" };
    res.render("about", { content, ui: res.locals.ui, user: req.session.user, requestPath: req.path });
  });

  app.get("/contact", async (req, res) => {
    const content = db.data.pages.contact?.[res.locals.lang] || { heroTitle: "", heroText: "" };
    res.render("contact", { content, message: "", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
  });

  app.post("/contact", async (req, res) => {
     const { name, email, message } = req.body;
     
     try {
       // Надсилаємо листа адміністратору (тобі)
       await transporter.sendMail({
         from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
         to: "sofiazhovnik11@gmail.com", // Лист прийде тобі
         replyTo: email, // Коли натиснеш "Відповісти", відповідь піде клієнту
         subject: `Nowa wiadomość od: ${name}`,
         text: `Użytkownik: ${name} (${email})\nNapisał: ${message}`
       });
       console.log("Email kontaktowy wysłany");
     } catch (e) {
       console.error("Błąd wysyłania maila:", e);
     }

     res.render("contact", { content: {}, message: "Wysłano!", ui: res.locals.ui, requestPath: req.path, user: req.session.user });
  });
// Контакт з власником оголошення
  app.post("/contact/:id", async (req, res) => {
      const offer = db.data.offers.find(o => o.id === req.params.id);
      
      if (offer) {
        const { name, email, message, phone } = req.body;
        
        // 🔥 ВИПРАВЛЕННЯ: Якщо у оголошення немає власника, шлемо адміну (тобі)
        const recipient = offer.user ? offer.user : "sofiazhovnik11@gmail.com";

        try {
          await transporter.sendMail({
            from: '"RealEstateCMS" <sofiazhovnik11@gmail.com>',
            to: recipient, // Використовуємо перевіреного отримувача
            replyTo: email,
            subject: `Pytanie o ogłoszenie: ${offer.title}`,
            text: `Witaj!\n\nUżytkownik ${name} interesuje się Twoim ogłoszeniem "${offer.title}".\n\nWiadomość:\n${message}\n\nKontakt do zainteresowanego:\nEmail: ${email}\nTelefon: ${phone || "Brak"}\n\nLink do ogłoszenia: http://localhost:3000/offers/${offer.id}`
          });
          console.log(`Wysłano zapytanie do: ${recipient}`);
        } catch (e) {
          console.error("Błąd wysyłania do właściciela:", e);
        }
      }

      // Передаємо user, щоб не ламався хедер
      res.render("offer-details", { offer, user: req.session.user, success: "Wysłano!" });
  });
  // --- 404 HANDLER ---
  app.use((req, res) => {
      res.status(404).send("Strona nie znaleziona (404)");
  });
// ================= УЛЮБЛЕНІ (FAVORITES) =================

// 1. AJAX Toggle (для JS без перезавантаження)
app.post("/favorites/toggle-ajax", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ success: false });

  await db.read();
  let isAdded = false;

  if (req.session.user) {
    // Логіка для зареєстрованого (БД)
    const userIndex = db.data.users.findIndex(u => u.username === req.session.user.username);
    if (userIndex !== -1) {
      const user = db.data.users[userIndex];
      if (!user.favorites) user.favorites = [];
      
      const idx = user.favorites.indexOf(id);
      if (idx === -1) { user.favorites.push(id); isAdded = true; } 
      else { user.favorites.splice(idx, 1); isAdded = false; }
      
      await db.write();
    }
  } else {
    // Логіка для гостя (Сесія)
    if (!req.session.favorites) req.session.favorites = [];
    const idx = req.session.favorites.indexOf(id);
    
    if (idx === -1) { req.session.favorites.push(id); isAdded = true; } 
    else { req.session.favorites.splice(idx, 1); isAdded = false; }
  }
  res.json({ success: true, isAdded });
});

// 2. GET Toggle (Запасний варіант, якщо JS не спрацює)
app.get("/favorites/toggle/:id", async (req, res) => {
  const { id } = req.params;
  await db.read();

  if (req.session.user) {
      const user = db.data.users.find(u => u.username === req.session.user.username);
      if (user) {
          if (!user.favorites) user.favorites = [];
          const idx = user.favorites.indexOf(id);
          if (idx === -1) user.favorites.push(id);
          else user.favorites.splice(idx, 1);
          await db.write();
      }
  } else {
      if (!req.session.favorites) req.session.favorites = [];
      const idx = req.session.favorites.indexOf(id);
      if (idx === -1) req.session.favorites.push(id);
      else req.session.favorites.splice(idx, 1);
  }
  res.redirect(req.get("Referer") || "/offers");
});

// 3. Сторінка "Мої улюблені"
app.get("/favorites", async (req, res) => {
  await db.read();
  
  let favIds = [];
  if (req.session.user) {
     const u = db.data.users.find(u => u.username === req.session.user.username);
     favIds = u?.favorites || [];
  } else {
     favIds = req.session.favorites || [];
  }
  
  const favorites = db.data.offers.filter(o => favIds.includes(o.id));
  
  res.render("favorites", { 
    offers: favorites, 
    user: req.session.user,
    // Передаємо ці змінні, щоб не було помилки "lang is not defined"
    lang: res.locals.lang,
    t: res.locals.t,
    ui: res.locals.ui,
    requestPath: req.path,
    favorites: favIds
  });
});
  // --- START SERVER ---
  app.listen(PORT, () => {
    console.log(`Server działa na http://localhost:${PORT}`);
  });
}

startServer().catch(err => console.error(err));