# Early Adopter Tracker - Contador.AI

## Google Sheets Template

**URL:** https://docs.google.com/spreadsheets/create (create new sheet)

### Columns (Row 1 = Headers)

| Column | Header | Type | Notes |
|--------|--------|------|-------|
| A | ID | Text | Auto: `=ROW()-1` |
| B | Nome | Text | Nome da pessoa |
| C | WhatsApp | Text | Número E.164 (+244...) |
| D | Bairro | Text | Viana, Rangel, Kilamba, etc. |
| E | Tipo Negócio | Text | Vendedor, cantineiro, outros |
| F | Data Contato | Date | Quando enviou mensagem |
| G | Versão Mensagem | Text | V1 (direta), V2 (prova social), V3 (dor) |
| H | Respondeu? | Checkbox | ✅ sim / ❌ não |
| I | Data Resposta | Date | Auto quando respondeu |
| J | Aceitou Testar? | Checkbox | ✅ sim / ❌ não |
| K | Data Início | Date | Quando começou a usar |
| L | Entrevistado? | Checkbox | ✅ sim / ❌ não |
| M | Data Entrevista | Date | Quando fez entrevista |
| N | Insights Chave | Text | Resumo do aprendizado |
| O | Caso Sucesso? | Checkbox | ✅ sim / ❌ não |
| P | Status | Text | Pendente / Respondido / Testando / Entrevistado / Inativo |

---

## Formulas (Auto-fill)

### Row 2 (first data row):

**A2 (ID):**
```
=ROW()-1
```

**I2 (Data Resposta - if H2 checked):**
```
=IF(H2=TRUE, TODAY(), "")
```

**K2 (Data Início - if J2 checked):**
```
=IF(J2=TRUE, TODAY(), "")
```

**M2 (Data Entrevista - if L2 checked):**
```
=IF(L2=TRUE, TODAY(), "")
```

**P2 (Status - auto):**
```
=IF(L2=TRUE, "Entrevistado", IF(J2=TRUE, IF(K2>=TODAY()-7, "Testando", "Inativo"), IF(H2=TRUE, "Respondido", "Pendente")))
```

---

## Summary Dashboard (Tab 2)

### Metrics (auto-calculated)

| Metric | Formula | Result |
|--------|---------|--------|
| Total Contatos | `=COUNTA(Sheet1!B:B)-1` | |
| Responderam | `=COUNTIF(Sheet1!H:H, TRUE)` | |
| Aceitaram Testar | `=COUNTIF(Sheet1!J:J, TRUE)` | |
| Entrevistas Feitas | `=COUNTIF(Sheet1!L:L, TRUE)` | |
| Casos Sucesso | `=COUNTIF(Sheet1!O:O, TRUE)` | |
| Taxa Resposta | `=B2/B1` | % |
| Taxa Conversão | `=B3/B1` | % |

---

## Usage Workflow

### 1. Add Contact
- Fill: Nome, WhatsApp, Bairro, Tipo Negócio
- Set: Data Contato = TODAY()
- Choose: Versão Mensagem (V1/V2/V3)
- Status = "Pendente"

### 2. Send Message
- Use template from `recruitment-message.md`
- Personalize with nome/bairro

### 3. Update Response
- When they reply: ✅ Respondeu?
- Status auto-updates to "Respondido"

### 4. Onboarding
- When they start: ✅ Aceitaram Testar?
- Status = "Testando"

### 5. Interview
- After 3-7 days: ✅ Entrevistado?
- Fill: Insights Chave
- Status = "Entrevistado"

### 6. Success Case
- If strong testimonial: ✅ Caso Sucesso?

---

## Daily Metrics Export

Run this daily and paste into Metrics tab:

```bash
cd C:\Users\ricki\Documents\Freelance\Projects\contador
node scripts/metrics-daily.js --days 1
```

**Metrics Tab Columns:**
| Date | New Users | Active Users | Total Messages | Confirmed Transactions | Debts Created | Retention D7 |

---

## Color Coding (Conditional Formatting)

| Status | Color |
|--------|-------|
| Pendente | Yellow |
| Respondido | Blue |
| Testando | Green |
| Entrevistado | Dark Green |
| Inativo | Gray |

---

## Export for Reports

**Weekly Report (every Monday):**
1. Filter: Status != "Pendente"
2. Copy: Nome, Bairro, Tipo, Status, Insights
3. Paste in weekly report doc

---

*Template created: 2026-03-18*
