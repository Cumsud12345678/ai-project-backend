# Car Advisor portal backend-i

Frontend (Next.js) ilə AI servisi (car-advisor) arasında duran backend. Müştəri hesabları, giriş, konfiqurasiyanın yoxlanması və AI servisinə ötürülməsi burada olur. AI servisinin müştəri açarını isə bu backend saxlamır: açar yaradılanda müştəriyə bir dəfə göstərilir.

```
brauzer ─► Next.js (3001) ─/api/portal/*► portal backend (4000) ─Bearer SERVICE_TOKEN► AI servisi (3000) ─► müştərinin elan API-si
                                              │
                                           MongoDB
```

## İşə salmaq

```bash
npm install
cp .env.example .env     # MONGODB_URI, AI_SERVICE_URL, AI_SERVICE_TOKEN, ADMIN_EMAILS yaz
npm run dev              # http://localhost:4000
npm test                 # 39 test (MongoDB lazım deyil, yaddaş store-u ilə)
```

Production: `npm run build && npm start`. `NODE_ENV=production` olanda `RESEND_API_KEY` və `MAIL_FROM` məcburidir (Resend-də domen təsdiqlənməlidir).

## Endpoint-lər

Hamısı JSON, sessiya `ca_session` httpOnly cookie-sindədir.

| Endpoint | İzah |
|---|---|
| `POST /auth/register` `{email, password}` | Hesab açır, emailə 6 rəqəmli kod göndərir |
| `POST /auth/verify` `{email, code}` | Emaili təsdiqləyir və daxil edir |
| `POST /auth/resend` `{email}` | Kodu yenidən göndərir |
| `POST /auth/login` `{email, password}` | Giriş (təsdiqsiz hesab: 403 `EMAIL_NOT_VERIFIED`) |
| `POST /auth/logout` | Sessiyanı bağlayır |
| `POST /auth/forgot` `{email}` · `POST /auth/reset` `{email, code, password}` | Parol sıfırlama |
| `GET /auth/me` | `{email, role}` |
| `GET /tenant` | Müştərinin mənbəyi və konfiqurasiyası (`null` ola bilər) |
| `POST /tenant/config/test` `{config}` | Konfiqurasiyanı və müştəri API-sinə bağlantını yoxlayır |
| `POST /tenant` `{config}` | Yoxlayır və aktivləşdirir, `apiKey` bir dəfə qaytarılır |
| `PUT /tenant/config` `{config}` | Konfiqurasiyanı yeniləyir (açar dəyişmir) |
| `PATCH /tenant/profile` | Dil, ton, `maxResults`, əlavə təlimat |
| `POST /tenant/key/rotate` | Yeni açar, köhnə dərhal işləmir |
| `GET /tenant/usage` · `GET /tenant/listings` · `POST /tenant/chat` | Panelin istifadə, elanlar və sınaq söhbəti səhifələri |
| `GET /tenant/widget` · `PUT /tenant/widget` · `POST /tenant/widget/rotate` | Çat vidjetinin ayarları (açar, başlıq, rəng, icazəli saytlar, aktiv/söndürülmüş), açarın yenilənməsi |
| `GET /admin/users` · `GET /admin/tenants/:id/usage` · `POST /admin/tenants/:id/rotate-key` | Yalnız `ADMIN_EMAILS` |

`config` AI servisinin konfiqurasiya formatıdır (`businessName`, `domain`, `profile`, `source`, istəyə görə `apiSecret`). Tanınmayan sahələr atılır. `apiSecret` bazada saxlanmır, AI servisinə ötürülür və orada şifrələnir.

## Çat vidjeti (müştəri saytına qoyulan script)

Müştəri panelin **Saytına qoş** səhifəsindən bir sətir kod götürür:

```html
<script src="https://PORTAL/widget.js" data-key="wk_..." defer></script>
```

Saytda sağ aşağıda çat düyməsi çıxır. Backend yazmağa ehtiyac yoxdur.

İctimai endpoint-lər (cookie tələb etmir, brauzerdən müştəri saytından çağırılır):

| Endpoint | İzah |
|---|---|
| `GET /widget.js` | Vidjet scripti (`widget/widget.js`), 5 dəqiqə keşlənir |
| `GET /widget/:key/config` | Başlıq, salamlama, rəng (yalnız ictimai sahələr) |
| `POST /widget/:key/chat` `{message, history}` | `{answer, listings}`; portal AI servisini müştəri üçün öz tokeni ilə çağırır |

Düymənin yeri (hamısı ixtiyaridir; panelin "Saytına qoş" səhifəsi bunları özü yazır). Ekran 3 pilləyə bölünür:

| Pillə | Ekran eni | Çat |
|---|---|---|
| **lg** (kompüter) | 1024px və çox | sağ aşağıda 380px pəncərə |
| **md** (planşet) | 768-1023px | sağ aşağıda 380px pəncərə |
| **sm** (telefon) | 767px və az | tam ekran, arxa fon scroll olunmur |

| Atribut | İzah |
|---|---|
| `data-position="left"` | Düymə solda (defolt: sağda) |
| `data-side` · `data-bottom` | **lg**: yan və aşağı kənardan məsafə, piksellə (defolt 20) |
| `data-side-md` · `data-bottom-md` | **md**: yazılmasa lg dəyəri |
| `data-side-sm` · `data-bottom-sm` | **sm**: yazılmasa md dəyəri (köhnə adlar `data-side-mobile` · `data-bottom-mobile` də işləyir) |
| `data-bp-md` · `data-bp-lg` | Pillələrin başladığı en: md 768, lg 1024 (defolt). Ən az 320 |

Dəyər yalnız rəqəm (0-3000) olmalıdır, yanlış dəyər yazılmamış sayılır (yuxarı pillədən miras alır). Saytın öz CSS-i də eyni nəticəni verir və atributdan üstün gəlir: `[data-car-advisor]{ --ca-side:30px; --ca-bottom:90px; --ca-side-md:..; --ca-bottom-md:..; --ca-side-sm:..; --ca-bottom-sm:..; --ca-z:9999 }`. Yalnız `--ca-side` yazsan, yazılmayan pillələrə də axır. Çat paneli həmişə düymənin 68px üstündə açılır.

Telefon pilləsində çat tam ekran açılır və arxadakı səhifə scroll olunmur. Bağlananda səhifə əvvəlki scroll mövqeyinə qayıdır. Planşet və kompüterdə kilid yoxdur.

Təhlükəsizlik modeli:

- **Gizli API açarı (`ca_live_…`) brauzerə çıxmır.** Vidjet ayrıca ictimai açar (`wk_…`) istifadə edir; onu hər kəs saytın HTML-indən görə bilər.
- Bu açar yalnız müştərinin **domenindən** (və `www`/alt domenlərindən) və panelde əlavə etdiyi ünvanlardan işləyir. Başqa sayt kodu kopyalasa, brauzer CORS səbəbilə söhbət aça bilmir. Qeyd: `Origin` yoxlaması brauzeri məhdudlaşdırır, serverdən saxta başlıqla sorğunu dayandırmır. Ona görə əsas qoruma limitlərdir.
- Limitlər: bir ziyarətçiyə (IP) dəqiqədə 8, saatda 80 mesaj; açar üzrə saatda 1500. Üstəlik AI servisindəki müştəri limiti (`DEFAULT_MONTHLY_REQUESTS`, `DEFAULT_RATE_PER_MINUTE`) hər halda tətbiq olunur. Real ziyarətçi IP-si üçün proxy arxasında `TRUST_PROXY` düzgün qurulmalıdır.
- Sızma halında müştəri paneldən vidjeti söndürə və ya açarı yeniləyə bilər (köhnə script dərhal dayanır).
- Ziyarətçiyə AI xətaları, limit və konfiqurasiya məlumatı göstərilmir, yalnız ümumi mesaj.
- Vidjet cavabı `innerHTML` olmadan göstərir (HTML mətn kimi çıxır), yalnız `http(s)` linklərə icazə verir, Shadow DOM-da işləyir və saytın CSS-i ilə qarışmır.

**Yerləşdirmə:** vidjet endpoint-ləri internetdən əlçatan olmalıdır, çünki onları müştərinin ziyarətçisi çağırır. Panelin `/auth`, `/tenant`, `/admin` yolları isə yalnız frontend-in proxy-sinə açıq qalmalıdır. Reverse proxy-də internetə yalnız `/widget.js` və `/widget/*` yollarını aç. `PUBLIC_PORTAL_URL` həmin ictimai HTTPS ünvan olmalıdır. Müştəri saytının CSP-si (`script-src`, `connect-src`) varsa, bu ünvana icazə verməlidir.

**Lokal sınaq:** `widget/demo.html` faylını açmazdan əvvəl panelde əlavə ünvan olaraq `http://localhost:5500` yaz, açarı fayla yapışdır və `npx serve -l 5500 widget` (və ya istənilən statik server) ilə aç.

## Təhlükəsizlik

- Parol `scrypt` ilə hash-lənir. Kodlar hash-lənmiş saxlanır, 15 dəqiqə etibarlıdır, 5 yanlış cəhddən sonra ləğv olunur.
- Giriş, qeydiyyat və kod yoxlaması IP və email üzrə limitlənir (yaddaşda; bir neçə replica üçün Redis lazımdır).
- Sessiya tokeni təsadüfi, bazada yalnız hash-i var. Çıxış və parol sıfırlama sessiyaları bazadan silir.
- Dəyişdirici sorğular yalnız `ALLOWED_ORIGINS`-dən qəbul edilir.
- Backend-in `/auth`, `/tenant`, `/admin` yolları internetə birbaşa açıq olmamalıdır: yalnız frontend-in proxy-si çatsın. Yalnız vidjet yolları (`/widget.js`, `/widget/*`) ictimai olur.
- Qeydiyyat açıqdır və yoxlamadan keçən konfiqurasiya avtomatik aktivləşir. Xərci AI servisinin `DEFAULT_MONTHLY_REQUESTS` limiti ilə idarə et.
