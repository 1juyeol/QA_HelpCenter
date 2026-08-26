# -*- coding: utf-8 -*-
# SMTP(아이디+비밀번호)로 메일을 보내는 클라이언트. 회사 그룹웨어(코비전)의 메일 서버
# gm.danbiedu.co.kr:587(STARTTLS)로 보낸다 — 경영지원실 총무 담당자에게 받은 SMTP 정보
# 기준. 이 서버는 사내망 전용이라 VPN 연결이 안 되어 있으면 연결 자체가 타임아웃난다.
# 호출부(daily_report_mailer.py/weekly_report_mailer.py)는 send_mail()의 시그니처만 알면
# 되고 SMTP 여부를 몰라도 된다. sender/recipient는 관리자 페이지(메일링 관리)에서 설정한
# 값을 그대로 넘겨받는다 — 이 파일 안에 고정값으로 두지 않는다.
#
# 이미지는 base64로 본문에 직접 박지 않고 CID 방식(첨부 후 <img src="cid:...">로 참조)으로
# 넣는다 — 사내 메일 클라이언트(Outlook 등)가 data: URI 이미지를 차단/미표시하는 경우가 흔해서다.
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from email.mime.text import MIMEText
from email.message import Message


def build_mime_message(subject: str, html_body: str, sender: str, recipient: str, image_cid: str | None = None, image_bytes: bytes | None = None) -> Message:
    """sender → recipient로 보낼 HTML 메일(MIME 메시지)을 조립한다. recipient는 여러 명이면
    쉼표로 구분된 문자열이어도 된다. image_bytes가 있으면 image_cid로 본문에서 참조 가능한
    인라인 이미지로 첨부한다 (html_body 안에 <img src="cid:{image_cid}">를 넣어야 함)."""
    msg = MIMEMultipart("related")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    if image_bytes and image_cid:
        image = MIMEImage(image_bytes)
        image.add_header("Content-ID", f"<{image_cid}>")
        image.add_header("Content-Disposition", "inline")
        msg.attach(image)

    return msg


def send_mail(subject: str, html_body: str, sender: str, recipient: str, image_cid: str | None = None, image_bytes: bytes | None = None) -> None:
    host = os.environ.get("MAIL_SMTP_HOST", "")
    port = int(os.environ.get("MAIL_SMTP_PORT", "587"))
    user = os.environ.get("MAIL_SMTP_USER", "")
    password = os.environ.get("MAIL_SMTP_PASSWORD", "")

    msg = build_mime_message(subject, html_body, sender, recipient, image_cid, image_bytes)

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        server.sendmail(sender, recipient, msg.as_string())
