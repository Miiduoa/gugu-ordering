from datetime import date, time
from typing import Literal
from uuid import UUID
import re
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

class CartItem(Model):
    product_id: str = Field(min_length=1,max_length=40,pattern=r'^[a-zA-Z0-9_-]+$')
    quantity: StrictInt = Field(ge=1,le=20)
    version: StrictInt = Field(ge=1)
    choices: dict[str,str] = Field(default_factory=dict, max_length=8)
    note: str = Field(default='',max_length=100)

class OrderInput(Model):
    idempotency_key: UUID
    name: str = Field(min_length=1,max_length=24)
    phone: str = Field(min_length=9,max_length=18)
    day: date
    slot: str = Field(pattern=r'^\d{2}:\d{2}$')
    items: list[CartItem] = Field(min_length=1,max_length=20)
    note: str = Field(default='',max_length=200)
    consent: bool
    @field_validator('phone')
    @classmethod
    def phone_number(cls,v):
        v=re.sub(r'[\s\-()]','',v)
        if v.startswith('+886'): v='0'+v[4:]
        if not re.fullmatch(r'0\d{8,9}',v):
            raise ValueError('請填寫台灣手機或市話號碼')
        return v
    @model_validator(mode='after')
    def total_count(self):
        if sum(i.quantity for i in self.items)>40: raise ValueError('單筆最多 40 份，大量訂餐請與店家聯繫')
        if not self.consent: raise ValueError('請先閱讀並同意訂購與個資說明')
        return self

class LoginInput(Model):
    username: str = Field(min_length=1,max_length=40)
    password: str = Field(min_length=1,max_length=128)

class ActionInput(Model):
    action: Literal['accept','prepare','ready','complete','cancel','reject','no_show','pay','refund']
    version: StrictInt = Field(ge=1)
    reason: str = Field(default='',max_length=120)
    confirm_cash: bool = False

class TokenInput(Model):
    token: str = Field(min_length=32,max_length=100,pattern=r'^[a-zA-Z0-9_-]+$')

class CancelInput(TokenInput):
    version: StrictInt = Field(ge=1)

class Choice(Model):
    id: str = Field(pattern=r'^[a-z0-9_-]{1,24}$')
    name: str = Field(min_length=1,max_length=24)
    price: StrictInt = Field(ge=0,le=1000)

class Option(Model):
    id: str = Field(pattern=r'^[a-z0-9_-]{1,24}$')
    name: str = Field(min_length=1,max_length=24)
    required: bool = True
    choices: list[Choice] = Field(min_length=1,max_length=8)
    @model_validator(mode='after')
    def unique_ids(self):
        if len({i.id for i in self.choices}) != len(self.choices): raise ValueError('選項 ID 不可重複')
        return self

class ProductInput(Model):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,40}$')
    name: str = Field(min_length=1,max_length=60)
    description: str = Field(default='',max_length=240)
    category: str = Field(min_length=1,max_length=24)
    price: StrictInt = Field(ge=1,le=3000)
    daily_stock: StrictInt = Field(ge=0,le=2000)
    active: bool = True
    sold_out: bool = False
    kind: Literal['meal','addon'] = 'meal'
    options: list[Option] = Field(default_factory=list,max_length=5)
    version: StrictInt = Field(default=0,ge=0)
    @model_validator(mode='after')
    def unique_options(self):
        if len({o.id for o in self.options})!=len(self.options): raise ValueError('規格 ID 不可重複')
        return self

class StockInput(Model):
    day: date
    product_id: str = Field(min_length=1,max_length=40)
    remaining: StrictInt = Field(ge=0,le=2000)
    expected_remaining: StrictInt = Field(ge=0,le=2000)
    reason: str = Field(min_length=1,max_length=100)

class SettingsInput(Model):
    name: str = Field(min_length=1,max_length=60)
    branch: str = Field(min_length=1,max_length=60)
    address: str = Field(min_length=1,max_length=120)
    phone: str = Field(min_length=1,max_length=24)
    announcement: str = Field(default='',max_length=240)
    paused: bool
    verified: bool
    prep_minutes: StrictInt = Field(ge=5,le=120)
    slot_minutes: Literal[10,15,20,30]
    slot_capacity: StrictInt = Field(ge=1,le=200)
    advance_days: StrictInt = Field(ge=0,le=7)
    accept_timeout: StrictInt = Field(ge=2,le=30)
    hours: dict[str,list[list[str]]]
    closed_dates: list[date] = Field(default_factory=list,max_length=60)
    privacy_days: StrictInt = Field(ge=7,le=90)
    version: StrictInt = Field(ge=1)
    @field_validator('hours')
    @classmethod
    def valid_hours(cls,v):
        if set(v) != {str(i) for i in range(7)}: raise ValueError('請完整設定週一至週日')
        for intervals in v.values():
            if len(intervals)>3: raise ValueError('每天最多三段營業時間')
            last='00:00'
            for pair in intervals:
                if len(pair)!=2: raise ValueError('時間需成對')
                a,b=pair
                for x in pair:
                    if not re.fullmatch(r'\d{2}:\d{2}',x): raise ValueError('請使用 HH:MM 格式')
                    time.fromisoformat(x)
                if not (last<=a<b): raise ValueError('時段不得重疊，結束需晚於開始')
                last=b
        return v

class PauseInput(Model):
    paused: bool
    version: StrictInt = Field(ge=1)

class UserInput(Model):
    username: str = Field(pattern=r'^[a-zA-Z0-9_-]{3,32}$')
    name: str = Field(min_length=1,max_length=24)
    role: Literal['cashier','kitchen']
    password: str = Field(min_length=12,max_length=128)

class PasswordInput(Model):
    current_password: str = Field(min_length=1,max_length=128)
    new_password: str = Field(min_length=12,max_length=128)

class UserUpdate(Model):
    active: bool
    password: str | None = Field(default=None,min_length=12,max_length=128)
