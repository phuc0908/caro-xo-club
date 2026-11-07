# Caro XO Club

Game Caro 15×15 trên trình duyệt, hỗ trợ chơi online qua mã phòng, hai người trên cùng máy hoặc đấu với AI ở 3 độ khó. Người chơi nối được ít nhất 5 quân liên tiếp theo hàng ngang, dọc hoặc chéo sẽ thắng.

Dự án sử dụng HTML, CSS, JavaScript thuần và Node.js; phòng online được lưu bằng Upstash Redis.

## Cách chạy

Yêu cầu Node.js 20 trở lên. Trong thư mục dự án, chạy:

```bash
npm run dev
```

Mở [http://localhost:3000](http://localhost:3000) để chơi cùng máy hoặc đấu với AI.

Để chơi online, sao chép `.env.example` thành `.env` và điền thông tin Upstash Redis:

```env
UPSTASH_REDIS_REST_URL=https://YOUR-DATABASE.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_PRIVATE_TOKEN
```

Khởi động lại server sau khi cập nhật `.env`.
