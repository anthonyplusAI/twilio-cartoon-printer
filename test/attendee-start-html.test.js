const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildAttendeeStartHtml, buildEventNoticeHtml } = require("../lib/attendee-start");

const channels = [{
    id: "sms",
    enabled: true,
    href: "sms:+14155550111?body=ready",
    title: "Text with SMS",
    description: "Opens Messages",
}];

test("Ask chooser offers page language choice without extra instructions", () => {
    const english = buildAttendeeStartHtml({ eventName: "Demo", locale: "en", languageMode: "ask", channels });
    const portuguese = buildAttendeeStartHtml({ eventName: "Demo", locale: "pt_BR", languageMode: "ask", channels });

    assert.doesNotMatch(english, /choose your chat language|Send the message, then reply with a selfie/);
    assert.match(english, /Page language:/);
    assert.match(english, /href="\/start\?event=Demo&amp;lang=pt_BR"/);
    assert.doesNotMatch(portuguese, /Se solicitado, escolha o idioma da conversa|Envie a mensagem e depois responda/);
    assert.match(portuguese, /Idioma da página:/);
});

test("fixed-language chooser omits extra instructions and a page language picker", () => {
    const html = buildAttendeeStartHtml({ eventName: "Demo", locale: "en", languageMode: "en", channels });

    assert.match(html, /Open a message below, then tap Send to begin\./);
    assert.doesNotMatch(html, /Send the message, then reply with a selfie|Page language:|choose your chat language/);
});

test("the start page presents the photo notice and launches SMS without a marketing choice", () => {
    const html = buildAttendeeStartHtml({ eventName: "Demo", locale: "en", languageMode: "en", channels });

    assert.match(html, /When you message the booth, Twilio receives your phone number and photo\. If this event asks for them, it may also collect your name, email, and country\./);
    assert.match(html, /The photo you send is shared with OpenAI for image checks, analysis, and portrait generation\./);
    assert.doesNotMatch(html, /remain in event storage|until staff deletes|theme-control/i);
    assert.match(html, /href="\/start\/notice\?event=Demo&amp;lang=en"/);
    assert.doesNotMatch(html, /<form[^>]+action="\/start\/open"/);
    assert.doesNotMatch(html, /marketing-choice|marketing-opt-in|Optional\. You can still get your portrait without this/);
    assert.match(html, /<a class="channel-button channel-sms" href="sms:\+14155550111\?body=ready"/);
    assert.doesNotMatch(html, /class="channel-button channel-whatsapp"/);
});

test("the full notice follows the supplied event terms and approved photo disclosures", () => {
    const html = buildEventNoticeHtml({ eventName: "Demo", locale: "en" });

    assert.match(html, /By participating in this experience, you affirm and agree to the following:/);
    const headings = [
        "Privacy Notice",
        "Marketing Enrollment",
        "AI Portrait Generation",
        "Data Collection",
        "Photo Retention",
        "Terms of Service",
    ];
    let previous = -1;
    for (const heading of headings) {
        const position = html.indexOf(`<h2>${heading}</h2>`);
        assert.ok(position > previous, `${heading} should appear in the stated order`);
        previous = position;
    }
    assert.match(html, /The photo you send is shared with OpenAI for image checks, analysis, and portrait generation\./);
    assert.match(html, /When you message the booth, Twilio receives your phone number and photo\./);
    assert.match(html, /Your original photo will be retained only as long as necessary to generate your portrait and will be deleted following the conclusion of the event\./);
    assert.match(html, /You authorize Twilio to reach out to you with marketing communications and enroll you in our automated promotional text messaging program\./);
    assert.doesNotMatch(html, /optional marketing choice/);
    assert.match(html, /18 years of age or older/);
    assert.match(html, /https:\/\/twil\.io\/privacy/);
    assert.match(html, /https:\/\/twil\.io\/terms/);
    assert.doesNotMatch(html, /remain in event storage|until event staff deletes/i);
});
