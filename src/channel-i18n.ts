// Telegram/WhatsApp botunun sistem mesajları (limit, səs, operator...) müştərinin dilində.
// AI cavabı onsuz da müştərinin dilindədir; bu mesajlar isə sabit mətn idi və həmişə Azərbaycanca gedirdi.
import type { TenantRecord } from "./store/types.js";

export type ChatLang = "az" | "en" | "ru" | "tr";
const LANGS: ChatLang[] = ["az", "en", "ru", "tr"];

/** Dil: kirill hərfi varsa rus, "ə" varsa Azərbaycan, əks halda biznesin profil dili (yoxdursa az). */
export function chatLang(t: Pick<TenantRecord, "config">, text = ""): ChatLang {
  if (/[а-яё]/i.test(text)) return "ru";
  if (/ə/i.test(text)) return "az";
  const l = (t.config as { profile?: { language?: unknown } } | undefined)?.profile?.language;
  return LANGS.includes(l as ChatLang) ? (l as ChatLang) : "az";
}

type Texts = {
  textOnly: string; tooLong: string; slowDown: string; dayLimit: string; busy: string; offline: string; askContact: string;
  imageOff: string; imageFail: string; voiceLong: string; voiceFail: string; actionBusy: string; actionUnknown: string; thanks: string; followup: string;
  live: { off: string; offHours: string; on: string; back: string; hint: string; failed: string };
};

export function channelTexts(lang: ChatLang, maxText: number, maxAudioSec: number): Texts {
  const T: Record<ChatLang, Texts> = {
    az: {
      textOnly: "Hələlik yalnız yazılı mesajlara cavab verə bilirəm. Sualınızı yazın.",
      tooLong: `Mesaj çox uzundur (maksimum ${maxText} simvol). Qısaldıb yenidən yazın.`,
      slowDown: "Çox tez-tez yazırsınız, bir az gözləyib yenidən yazın.",
      dayLimit: "Bu gün üçün sual limitinə çatdınız. Sabah yenidən yazın.",
      busy: "Çat müvəqqəti məşğuldur, bir azdan yenidən yazın.",
      offline: "Çat hazırda cavab verə bilmir. Bir az sonra yenidən yazın.",
      askContact: "Bu sualın cavabını tapa bilmədim. İstəsəniz operator sizinlə əlaqə saxlasın: telefon nömrənizi və ya e-poçtunuzu yazın.",
      imageOff: "Şəkil qəbul edə bilmirəm. Sualınızı yazın.",
      imageFail: "Şəkli oxuya bilmədim (PNG, JPG və ya WebP, kiçik ölçüdə olmalıdır). Başqa şəkil göndərin və ya sualı yazın.",
      voiceLong: `Səsli mesaj çox uzundur (maksimum ${maxAudioSec} saniyə). Qısa göndərin və ya sualı yazın.`,
      voiceFail: "Səsli mesajı eşidə bilmədim. Yenidən göndərin və ya sualı yazın.",
      actionBusy: "Əməliyyat təsdiqi üçün çox cəhd etdiniz, bir az gözləyin.",
      actionUnknown: "Əməliyyatın icra olunub-olunmadığı bəlli deyil. Təkrar etməyin, operatorla yoxlayın.",
      thanks: "Təşəkkürlər, müraciətiniz qəbul edildi. Operator tezliklə sizinlə əlaqə saxlayacaq.",
      followup: "Sualınız qaldımı? Kömək lazım olsa yazın, məmnuniyyətlə cavab verərəm 🙂",
      live: {
        off: "Operatorla canlı yazışma hazırda aktiv deyil. Sualınızı yazın, mən cavab verim.",
        offHours: "Operatorlar hazırda işləmir. Sualınızı yazın, mən cavab verim; və ya telefon nömrənizi/e-poçtunuzu yazın, operator iş vaxtı sizinlə əlaqə saxlayacaq.",
        on: "Operatora qoşulursunuz. Mesajınızı yazın, operator sizə burada cavab verəcək. Botla davam etmək üçün /bot yazın.",
        back: "Operator söhbəti bitirdi. Yenə sualınız olsa, yazın.",
        hint: "Operatorla yazışmaq üçün /operator yazın.",
        failed: "Operatorun mesajı sizə çatdırıla bilmədi.",
      },
    },
    en: {
      textOnly: "For now I can only reply to text messages. Please type your question.",
      tooLong: `The message is too long (max ${maxText} characters). Please shorten it and try again.`,
      slowDown: "You're writing too often, please wait a moment and try again.",
      dayLimit: "You've reached today's question limit. Please write again tomorrow.",
      busy: "The chat is busy right now, please try again shortly.",
      offline: "The chat can't answer right now. Please try again a bit later.",
      askContact: "I couldn't find the answer to this. If you like, an operator can contact you: send your phone number or email.",
      imageOff: "I can't accept images. Please type your question.",
      imageFail: "I couldn't read the image (PNG, JPG or WebP, small size). Send another image or type your question.",
      voiceLong: `The voice message is too long (max ${maxAudioSec} seconds). Send a shorter one or type your question.`,
      voiceFail: "I couldn't hear the voice message. Send it again or type your question.",
      actionBusy: "Too many confirmation attempts, please wait a moment.",
      actionUnknown: "It's not known whether the action was carried out. Don't repeat it; check with an operator.",
      thanks: "Thank you, your request was received. An operator will contact you soon.",
      followup: "Do you have any other questions? Just write if you need help, I am happy to answer 🙂",
      live: {
        off: "Live chat with an operator isn't available right now. Type your question and I'll answer.",
        offHours: "Operators aren't working right now. Type your question and I'll answer, or send your phone number/email and an operator will contact you during working hours.",
        on: "Connecting you to an operator. Type your message and the operator will reply here. Type /bot to continue with the bot.",
        back: "The operator ended the chat. Write again if you have more questions.",
        hint: "Type /operator to chat with an operator.",
        failed: "The operator's message couldn't be delivered to you.",
      },
    },
    ru: {
      textOnly: "Пока я отвечаю только на текстовые сообщения. Напишите ваш вопрос.",
      tooLong: `Сообщение слишком длинное (максимум ${maxText} символов). Сократите и отправьте снова.`,
      slowDown: "Вы пишете слишком часто, подождите немного и напишите снова.",
      dayLimit: "Вы достигли дневного лимита вопросов. Напишите завтра.",
      busy: "Чат сейчас занят, попробуйте чуть позже.",
      offline: "Чат сейчас не может ответить. Попробуйте немного позже.",
      askContact: "Я не нашёл ответа на этот вопрос. Если хотите, оператор свяжется с вами: напишите номер телефона или e-mail.",
      imageOff: "Я не принимаю изображения. Напишите ваш вопрос.",
      imageFail: "Не удалось прочитать изображение (PNG, JPG или WebP, небольшого размера). Отправьте другое или напишите вопрос.",
      voiceLong: `Голосовое сообщение слишком длинное (максимум ${maxAudioSec} секунд). Отправьте короче или напишите вопрос.`,
      voiceFail: "Не удалось расслышать голосовое сообщение. Отправьте снова или напишите вопрос.",
      actionBusy: "Слишком много попыток подтверждения, подождите немного.",
      actionUnknown: "Неизвестно, было ли выполнено действие. Не повторяйте его, уточните у оператора.",
      thanks: "Спасибо, ваша заявка принята. Оператор скоро свяжется с вами.",
      followup: "Остались вопросы? Напишите, если нужна помощь, я с радостью отвечу 🙂",
      live: {
        off: "Чат с оператором сейчас недоступен. Напишите вопрос, и я отвечу.",
        offHours: "Операторы сейчас не работают. Напишите вопрос, и я отвечу, или оставьте телефон/e-mail, и оператор свяжется с вами в рабочее время.",
        on: "Подключаем оператора. Напишите сообщение, оператор ответит здесь. Чтобы вернуться к боту, напишите /bot.",
        back: "Оператор завершил чат. Если появятся вопросы, пишите.",
        hint: "Чтобы написать оператору, отправьте /operator.",
        failed: "Не удалось доставить вам сообщение оператора.",
      },
    },
    tr: {
      textOnly: "Şimdilik yalnızca yazılı mesajlara cevap verebiliyorum. Lütfen sorunuzu yazın.",
      tooLong: `Mesaj çok uzun (en fazla ${maxText} karakter). Kısaltıp tekrar yazın.`,
      slowDown: "Çok sık yazıyorsunuz, biraz bekleyip tekrar yazın.",
      dayLimit: "Bugünkü soru sınırına ulaştınız. Yarın tekrar yazın.",
      busy: "Sohbet şu anda yoğun, biraz sonra tekrar deneyin.",
      offline: "Sohbet şu anda cevap veremiyor. Biraz sonra tekrar deneyin.",
      askContact: "Bu sorunun cevabını bulamadım. İsterseniz bir operatör sizinle iletişime geçsin: telefon numaranızı veya e-postanızı yazın.",
      imageOff: "Görsel kabul edemiyorum. Lütfen sorunuzu yazın.",
      imageFail: "Görseli okuyamadım (PNG, JPG veya WebP, küçük boyutta). Başka bir görsel gönderin veya sorunuzu yazın.",
      voiceLong: `Sesli mesaj çok uzun (en fazla ${maxAudioSec} saniye). Daha kısa gönderin veya sorunuzu yazın.`,
      voiceFail: "Sesli mesajı anlayamadım. Tekrar gönderin veya sorunuzu yazın.",
      actionBusy: "Çok fazla onay denemesi yaptınız, biraz bekleyin.",
      actionUnknown: "İşlemin yapılıp yapılmadığı belli değil. Tekrarlamayın, bir operatörle kontrol edin.",
      thanks: "Teşekkürler, talebiniz alındı. Bir operatör yakında sizinle iletişime geçecek.",
      followup: "Başka sorunuz var mı? Yardım gerekirse yazın, memnuniyetle yanıtlarım 🙂",
      live: {
        off: "Operatörle canlı sohbet şu anda aktif değil. Sorunuzu yazın, ben cevaplayayım.",
        offHours: "Operatörler şu anda çalışmıyor. Sorunuzu yazın, ben cevaplayayım; ya da telefon/e-posta bırakın, operatör mesai saatinde size ulaşsın.",
        on: "Operatöre bağlanıyorsunuz. Mesajınızı yazın, operatör burada cevap verecek. Botla devam etmek için /bot yazın.",
        back: "Operatör sohbeti bitirdi. Başka sorunuz olursa yazın.",
        hint: "Operatörle yazışmak için /operator yazın.",
        failed: "Operatörün mesajı size iletilemedi.",
      },
    },
  };
  return T[lang];
}
