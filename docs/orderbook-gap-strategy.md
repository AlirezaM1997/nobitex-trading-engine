# Orderbook Gap / Liquidity Vacuum

## نتیجه‌ی مهندسی

این موتور جایگزین Market Making است، اما **آربیتراژ قطعی نیست**. فاصله‌ی خالی میان دو سطح قیمت فقط نشان می‌دهد دفتر سفارش در آن ناحیه شکننده است؛ جهت حرکت و امکان کسب سود باید با جریان سفارش، ماندگاری، عمق مؤثر و هزینه‌ی اجرای واقعی تأیید شود.

نسخه‌ی فعلی پروژه عمداً `Shadow/Paper` است و هیچ سفارش واقعی ارسال نمی‌کند. اسکن REST یک‌ثانیه‌ای می‌تواند Gap، عمق، اسپرد، اثر قیمت و تداوم چند Snapshot را بسنجد، ولی برای تشخیص OFI، لغو سریع سفارش‌ها، عمر نقدینگی و Trade Flow کافی نیست.

## تعریف کمی

برای Askهای مرتب‌شده‌ی `a1 < a2 < ...` و Bidهای `b1 > b2 > ...`:

- `askGap(i) = 10000 × ln(a(i+1) / a(i))`
- `bidGap(i) = 10000 × ln(b(i) / b(i+1))`
- `mid = (bestAsk + bestBid) / 2`
- `spreadBps = 10000 × (bestAsk - bestBid) / mid`
- `microprice = (bestAsk × bidQty1 + bestBid × askQty1) / (bidQty1 + askQty1)`

برای هر بازار، Gap نزدیک قیمت با Median/MAD فاصله‌های همان دفتر مقایسه می‌شود. آستانه‌ی ثابت BPS به‌تنهایی معتبر نیست؛ اندازه Tick، قیمت، عمق و رژیم نقدشوندگی بازارها متفاوت‌اند.

## فیلترهای نسخه‌ی Shadow

یک کاندید صعودی Spot فقط وقتی نمایش داده می‌شود که همه‌ی موارد زیر بررسی شوند:

1. بازار IRT و اردربوک تازه باشد.
2. Gap سمت Ask نزدیک قیمت، هم از حداقل مطلق و هم از آستانه‌ی robust عبور کند.
3. Gap در چند Snapshot باقی بماند و عمر آن از سقف تعیین‌شده بیشتر نشود.
4. عمق Bid، نسبت عدم‌تعادل و Microprice فشار صعودی را تأیید کنند.
5. نقدینگی روی Level اول بیش از حد متمرکز نباشد؛ این فقط `Ephemeral Liquidity Risk` است و تشخیص قطعی Spoofing نیست.
6. سرمایه‌ی آزمایشی بخش کوچکی از نقدینگی پیش از Gap را مصرف کند تا خود ربات عامل پرش قیمت نباشد.
7. خرید و خروج فوری با walk واقعی اردربوک از سقف Spread/Impact عبور نکنند.
8. حرکت قابل‌تصرف تخمینی پس از دو کارمزد Taker، لغزش و هزینه‌ی رفت‌وبرگشت مثبت بماند.

حتی عبور از تمام این فیلترها به معنی سود تضمین‌شده نیست و سیگنال در نسخه‌ی فعلی `Live Actionable` نمی‌شود.

## پیش‌نیاز Live Spot

فعال‌سازی اجرای واقعی فقط پس از تکمیل این موارد قابل دفاع است:

- دریافت پیوسته‌ی کانال‌های WebSocket اردربوک و معاملات عمومی؛
- Bootstrap از Orderbook V3 و کنترل پیوستگی offset/recovery؛
- محاسبه‌ی OFI/MLOFI و Aggressive Trade Flow در سطح رویداد؛
- ثبت latency از تصمیم تا ACK/Fill و haircut بر اساس صدک‌های بدبینانه؛
- مدل عمر/بقای نقدینگی و نرخ add/cancel بر اساس داده‌ی خود نوبیتکس؛
- replay رویدادمحور، walk-forward و Shadow Live با نمونه‌ی کافی؛
- ثبت immutable feature/config/version برای هر تصمیم و سنجش markout واقعی؛
- اتصال همان Position State، reconciliation، Stop، Time Stop و Recovery موجود در پروژه.

## OTC نوبیتکس

OTC/RFQ دفتر سفارش عمومی با Levelهای پایدار ندارد؛ بنابراین «Gap اردربوک OTC» تعریف اجرایی ندارد. API عمومی فعلی نوبیتکس نیز قرارداد رسمی و مستندی برای دریافت Quote firm، TTL، اجرای idempotent و وضعیت معامله OTC ارائه نمی‌کند. در نتیجه OTC در داشبورد فقط به‌عنوان محدودیت پژوهشی نمایش داده می‌شود و fail-closed است.

اگر در آینده API رسمی ارائه شود، موتور جداگانه باید اختلاف `firm OTC quote` با `size-matched Spot VWAP` را پس از کارمزد، TTL، ریسک acceptance و settlement بسنجد؛ استفاده‌ی مجدد از منطق CLOB Gap برای OTC صحیح نیست.

## منابع اصلی

- [Large price changes and order-book gaps](https://arxiv.org/abs/cond-mat/0312703)
- [The Price Impact of Order Book Events](https://arxiv.org/abs/1011.6402)
- [Queue Imbalance as a One-Tick-Ahead Price Predictor](https://arxiv.org/abs/1512.03492)
- [Nobitex WebSocket orderbook/trades documentation](https://apidocs.nobitex.ir/websocket/websocket-orderbook-channel)
- [Nobitex V3 orderbook](https://apidocs.nobitex.ir/market_data/دریافت-دفتر-سفارشات-نسخه-۳)
- [Nobitex API terms](https://apidocs.nobitex.ir/terms/)
