#!/usr/bin/env python3
"""把舊帳本「客注品精算確認リスト」Excel 轉成訂金管理系統的匯入檔（JSON）。

用法： python3 tools/convert_ledger.py <舊帳本.xlsx> <輸出.json>
輸出檔含客戶個資，請勿放進 Git。之後在系統「設定 → 匯入舊帳本」上傳。
"""
import datetime, json, re, sys, warnings
import openpyxl

SHEET_HINT = '客注品'
FIRST_ROW = 14  # 第 14 列起為資料（第 12 列是記入例）


def ymd(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%Y-%m-%d')
    m = re.search(r'(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})', str(v or ''))  # 例：前面多了 Tab 的文字日期
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass
    return ''


def text(v):
    return re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''


def phone(v):
    if v is None:
        return ''
    if isinstance(v, (int, float)):
        s = str(int(v))
        return '0' + s if len(s) == 9 and s.startswith('9') else s  # Excel 把開頭的 0 吃掉的手機號碼
    return re.sub(r'[\s\-()]', '', str(v))


def amount(v):
    return int(round(v)) if isinstance(v, (int, float)) and v > 0 else 0


def method(raw, order_date):
    """支払類別 → (支付方式, 入金日, 補充說明)"""
    s = text(raw)
    m = re.search(r'[(（]\s*(\d{1,2})\s*/\s*(\d{1,2})\s*[)）]', s)
    pay_date = ''
    if m and order_date:
        y, mo, d = int(order_date[:4]), int(m.group(1)), int(m.group(2))
        try:
            dt = datetime.date(y, mo, d)
            od = datetime.date.fromisoformat(order_date)
            if (od - dt).days > 180:      # 例：12 月受注、1 月入金
                dt = datetime.date(y + 1, mo, d)
            elif (dt - od).days > 180:    # 例：1 月受注、前一年 12 月入金
                dt = datetime.date(y - 1, mo, d)
            pay_date = dt.isoformat()
        except ValueError:
            pass
    base = re.sub(r'[(（].*?[)）]', '', s).strip()
    if '銀行' in base or '入金' in base or '轉帳' in base:
        return '銀行轉帳', pay_date, ''
    if '信用' in base:
        return '信用卡', pay_date, ''
    if base.upper().replace(' ', '') == 'LINEPAY':
        return 'LINE Pay', '', ''
    if base == '現金':
        return '現金', '', ''
    return '其他', '', base  # 例：振興券


def convert(path):
    warnings.simplefilter('ignore')
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = next(w for w in wb if SHEET_HINT in w.title and '保存' not in w.title)
    records, issues, used, last_date = [], [], set(), ''
    for i, r in enumerate(ws.iter_rows(min_row=FIRST_ROW, max_col=19, values_only=True), start=FIRST_ROW):
        if not (r[3] or r[5] or r[9]):
            continue
        no = text(int(r[1]) if isinstance(r[1], (int, float)) else r[1]) or f'R{i}'
        if no in used:
            issues.append(f'第 {i} 列：No. {no} 重複，改用 {no}-{i}')
            no = f'{no}-{i}'
        used.add(no)
        date = ymd(r[2])
        if not date:
            date = last_date
            issues.append(f'第 {i} 列（No. {no}）：沒有受注日，沿用上一筆的 {date}')
        last_date = date
        dep = amount(r[9])
        if not dep:
            issues.append(f'第 {i} 列（No. {no}）：前受金不是正數，略過')
            continue
        total = amount(r[6])
        if total and total < dep:
            issues.append(f'第 {i} 列（No. {no}）：受注金額 {total} 小於前受金 {dep}，商品總價改為未定')
            total = 0
        pay_method, pay_date, pay_extra = method(r[8], date)
        invoices = [x for x in re.split(r'\s*(?:→|->|⇒)\s*', text(r[11]).replace('-', '')) if x]
        note = text(r[13])
        final_inv = ''
        m = re.search(r'結帳的?發票號碼\s*[:：]?\s*([A-Za-z]{2}-?\d{8})?', note)
        if m:
            final_inv = (m.group(1) or '').replace('-', '').upper()
            note = (note[:m.start()] + note[m.end():]).strip(' ／/、')
        source = next((k for k in ('蝦皮', 'FB', 'LINE') if k.lower() in note.lower()), '')
        contact, settled = text(r[15]), ymd(r[16])
        if contact == 'キャンセル':
            outcome = 'refunded'
        elif settled:
            outcome = 'closed'
        else:
            outcome = 'active'
        arrived = ymd(r[14])
        notes = [note]
        if len(invoices) > 1:
            notes.append('發票換開：' + ' → '.join(invoices))
        if pay_extra:
            notes.append('支付類別：' + pay_extra)
        if contact and contact not in ('連絡済', 'キャンセル'):
            notes.append('連絡狀況：' + contact)
        records.append({
            'legacyNo': no, 'date': date, 'customer': text(r[3]) or '（未填）', 'phone': phone(r[4]),
            'itemName': text(r[5]) or '（未填）', 'totalPrice': total, 'createdBy': text(r[7]), 'source': source,
            'deposit': {'amount': dep, 'method': pay_method, 'payDate': pay_date, 'date': ymd(r[10]) or date,
                        'invoiceNo': invoices[-1].upper() if invoices else '', 'staff': text(r[12]) or text(r[7])},
            'outcome': outcome, 'stage': 'notified' if contact == '連絡済' else ('arrived' if arrived else 'ordered'),
            'arrivedAt': arrived, 'closedDate': settled or (date if outcome == 'refunded' else ''), 'closedBy': text(r[17]),
            'finalInvoice': final_inv, 'note': '／'.join(n for n in notes if n),
            'posted': text(r[0]) == '〇', 'reviewed': text(r[18]) == '〇',
        })
    return records, issues


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    recs, issues = convert(sys.argv[1])
    json.dump({'format': 'deposit-legacy-v1', 'records': recs}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
    by = lambda k: sum(r['deposit']['amount'] for r in recs if r['outcome'] == k)
    print(f'轉出 {len(recs)} 筆 → {sys.argv[2]}')
    print(f"前受金總計 {sum(r['deposit']['amount'] for r in recs):,}｜已精算 {by('closed'):,}｜取消 {by('refunded'):,}｜未精算 {by('active'):,}")
    print('狀態筆數', {k: sum(1 for r in recs if r['outcome'] == k) for k in ('active', 'closed', 'refunded')})
    print('支付方式', {k: sum(1 for r in recs if r['deposit']['method'] == k) for k in sorted({r['deposit']['method'] for r in recs})})
    print(f'需留意 {len(issues)} 項：'); [print('  ' + x) for x in issues]
