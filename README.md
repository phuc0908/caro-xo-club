# Caro XO Club 🎮

Dự án Caro 15×15 cá nhân, sử dụng HTML/CSS/JavaScript thuần, Node.js và Upstash Redis.

> **Nguồn gốc:** Bản mã nguồn độc lập được tái tạo dựa trên chức năng và giao diện website Caro XO Club đang triển khai. Đây **không phải** bản sao byte-for-byte toàn bộ source từ deployment Vercel; API và giao diện đã được cấu trúc lại để tiện chỉnh sửa và quản lý GitHub.

## Tính năng

- Chơi **online 2 người** qua mã phòng 6 ký tự; link mời `/?room=ABC123` mở popup chấp nhận lời thách đấu.
- Chơi **cùng máy** trên một bàn cờ.
- **Đấu với AI** 3 độ khó (Dễ / Trung bình / Khó), tính toán bằng JavaScript trong trình duyệt, không cần OpenAI API.
- Phát hiện thắng khi nối ít nhất 5 quân theo hàng ngang, dọc hoặc đường chéo.
- Nước đi cuối, hiệu ứng đặt quân, thông báo trạng thái, chơi lại và yêu cầu tái đấu online có xác nhận 2 phía.
- Giao diện sáng, X xanh ngọc, O xanh navy, hỗ trợ màn hình điện thoại.

## Yêu cầu

- Node.js **20+**.
- Internet để tải font (không bắt buộc) và sử dụng Vercel/Upstash.
- Tài khoản **Upstash Redis** nếu muốn tạo và tham gia phòng online.

## Chạy trên máy

```bash
# 1. Giải nén ZIP và mở thư mục
cd caro-xo-club

# 2. Tạo biến môi trường để bật phòng online (không bắt buộc cho Local/AI)
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
# Sửa URL và TOKEN Upstash trong file .env

# 3. Chạy app (không có dependency npm bắt buộc)
npm run dev
```

Truy cập **http://localhost:3000**.

Bạn có thể chơi **AI hoặc Local ngay cả khi chưa cấu hình Redis**. Online yêu cầu `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN` hợp lệ.

## Redis và bảo mật

Cấu hình trong `.env` khi chạy local và tại **Vercel → Project → Settings → Environment Variables** khi deploy:

```env
UPSTASH_REDIS_REST_URL=https://YOUR-DATABASE.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_PRIVATE_TOKEN
```

- Không commit `.env` lên GitHub.
- Không đưa token Upstash hoặc `OPENAI_API_KEY` vào `public/index.html`.
- `.env.example` chỉ chứa placeholder, không có thông tin bí mật.
- API sử dụng token định danh ngẫu nhiên cho mỗi người chơi và Redis CAS để tránh mất nước đi khi 2 request cùng lúc.
- TTL phòng online: 24 giờ kể từ lần cập nhật gần nhất.
- Hiện tại chưa có login hoặc hạn mức request theo IP; **nên thêm rate limit trước khi triển khai game công khai quy mô lớn**.

## Deploy lên Vercel

1. Tạo repository GitHub và push source code (hướng dẫn phía dưới).
2. Vào Vercel → Add New → Project → Import repository `caro-xo-club`.
3. Framework Preset: **Other**; Root Directory: repository root.
4. Thêm 2 biến môi trường Upstash như trên cho môi trường Production (và Preview nếu cần).
5. Deploy. `vercel.json` sẽ tự nhận `/api/game` và trang chủ.

**Nếu muốn dùng domain đang chạy** `caro-xo-club.vercel.app`, hãy liên kết repo này với **Vercel project hiện có**, không import thành dự án khác có domain mới. Kiểm tra cài đặt Git của project trên Vercel trước khi liên kết.

## Đưa dự án lên GitHub

Tạo repo **trống** tại https://github.com/new (không cần chọn README). Sau đó:

```bash
git init
git add .
git commit -m "feat: initial Caro XO Club source"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/caro-xo-club.git
git push -u origin main
```

Nếu repository đã có sẵn README trên GitHub, nên clone repo đó rồi chép file nguồn vào để tránh lỗi lịch sử Git khác nhau.

## Sơ đồ thư mục

```text
caro-xo-club/
├── api/
│   └── game.js           # Backend online (Upstash Redis REST)
├── public/
│   └── index.html        # UI, state, AI engine, lời mời
├── dev-server.mjs        # Máy chủ Node để test local
├── vercel.json           # Route và Function Vercel
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## API online

| Method | Endpoint | Body / Params |
|---|---|---|
| GET | `/api/game?room=ABC123` | Trạng thái phòng, không trả player ID |
| POST | `/api/game` | `{ "action": "create", "name": "Phuc" }` |
| POST | `/api/game` | `{ "action": "join", "room": "ABC123", "name": "Ban", "id": "optional-existing-id" }` |
| POST | `/api/game` | `{ "action": "move", "room": "ABC123", "id": "private-player-id", "row": 7, "col": 7 }` |
| POST | `/api/game` | `{ "action": "rematch", "room": "ABC123", "id": "private-player-id" }` |

## Kế hoạch nâng cấp

- Chia `public/index.html` thành các module CSS / JS.
- Viết Playwright end-to-end tests cho hai trình duyệt cùng tham gia một phòng.
- Thêm rate limit, xử lý room stale, logging.
- Thêm AI Coach gọi OpenAI qua **backend**, tuyệt đối không gọi bằng key từ browser.

## Tính tương thích

Source mới **không tự động đồng bộ** với phòng online đang chạy trên website cũ. Nếu dùng cùng Upstash Redis namespace, dữ liệu cơ bản tương thích về cấu trúc nhưng nên kiểm thử trên cơ sở dữ liệu thử nghiệm trước khi chuyển production.
