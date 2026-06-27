# -*- coding: utf-8 -*-
import os

content = """\
<view class="container">
  <view class="page-header">
    <image class="header-mascot" src="/images/share.jpg" mode="aspectFit"></image>
    <view class="header-info">
      <text class="header-title">{{appName}}</text>
      <text class="header-subtitle" wx:if="{{isBound}}">和{{partnerName}}的专属小厨房</text>
      <text class="header-subtitle" wx:else>快去绑定你的另一半吧</text>
    </view>
  </view>

  <view class="settings-section">
    <view class="section-title">账号信息</view>
    <view class="settings-card">
      <view class="settings-item" bindtap="openEditProfile">
        <image class="item-avatar" src="{{userAvatar or 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'}}" mode="aspectFill"></image>
        <view class="item-content">
          <text class="item-label">我的身份</text>
          <text class="item-name">{{userName}}</text>
        </view>
        <text class="item-arrow">&gt;</text>
      </view>
      <view class="settings-item" bindtap="goToBind">
        <text class="item-icon">\U0001F495</text>
        <text class="item-label">我的另一半</text>
        <view class="item-right" wx:if="{{isBound}}">
          <image class="partner-mini-avatar" src="{{partnerAvatar or 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'}}" mode="aspectFill"></image>
          <text class="item-value">{{partnerName}}</text>
        </view>
        <text wx:else class="item-value unbound">未绑定</text>
        <text class="item-arrow">&gt;</text>
      </view>
    </view>
  </view>

  <view class="settings-section">
    <view class="section-title">数据统计</view>
    <view class="settings-card">
      <view class="settings-item">
        <text class="item-icon">\U0001F37D</text>
        <text class="item-label">菜品总数</text>
        <text class="item-value">{{dishCount}} 道</text>
      </view>
      <view class="settings-item">
        <text class="item-icon">\U0001F4CB</text>
        <text class="item-label">点菜次数</text>
        <text class="item-value">{{orderCount}} 次</text>
      </view>
    </view>
  </view>

  <view class="settings-section">
    <view class="section-title">消息通知</view>
    <view class="settings-card">
      <view class="settings-item" bindtap="requestNotifyPermission">
        <text class="item-icon">\U0001F514</text>
        <text class="item-label">订阅消息</text>
        <text class="item-arrow">&gt;</text>
      </view>
    </view>
  </view>

  <view class="settings-section">
    <view class="section-title">关于</view>
    <view class="settings-card">
      <view class="settings-item">
        <text class="item-icon">\U0001F4F1</text>
        <text class="item-label">版本号</text>
        <text class="item-value">v1.0.0</text>
      </view>
      <button class="settings-item contact-btn" open-type="contact">
        <text class="item-icon">\U0001F4AC</text>
        <text class="item-label">联系作者</text>
        <text class="item-arrow">&gt;</text>
      </button>
    </view>
  </view>

  <view class="footer">
    <text class="footer-text" wx:if="{{isBound}}">Made with \U0001F380 for {{partnerName}}</text>
    <text class="footer-text" wx:else>Made with \U0001F380</text>
  </view>

  <view wx:if="{{_showSheet}}" class="sheet-overlay {{showEditModal ? '' : 'sheet-overlay--hidden'}}" catchtap="closeEditModal">
    <view class="sheet-panel {{showEditModal ? '' : 'sheet-panel--hidden'}}" catchtap="preventClose">
      <view class="sheet-handle">
        <view class="sheet-handle__bar"></view>
      </view>
      <view class="sheet-header">
        <text class="sheet-title">编辑个人信息</text>
        <text class="sheet-desc">设置头像和昵称，让大家认识你</text>
      </view>
      <view class="sheet-body">
        <view class="avatar-area">
          <button class="avatar-pick-btn" open-type="chooseAvatar" bindchooseavatar="onChooseAvatar">
            <image class="avatar-pick-img" src="{{tempAvatarUrl or userAvatar or 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'}}" mode="aspectFill"></image>
            <view class="avatar-pick-badge"><text>\U0001F4F7</text></view>
          </button>
          <text class="avatar-pick-hint">点击更换头像</text>
        </view>
        <view class="nick-area">
          <text class="nick-label">昵称</text>
          <view class="nick-input-wrap">
            <input class="nick-input" type="nickname" placeholder="点击输入昵称" value="{{tempNickname}}" bindinput="onNicknameInput" focus="{{showEditModal}}" />
          </view>
          <view class="nick-hint">
            <text class="nick-hint__icon">\U0001F4A1</text>
            <text class="nick-hint__text">点击输入框，键盘上方可选择微信昵称</text>
          </view>
        </view>
      </view>
      <view class="sheet-footer">
        <view class="sheet-btn sheet-btn--cancel" bindtap="closeEditModal">取消</view>
        <view class="sheet-btn sheet-btn--save {{saving ? 'sheet-btn--loading' : ''}}" bindtap="saveProfile">
          <text wx:if="{{!saving}}">保存</text>
          <text wx:else>保存中...</text>
        </view>
      </view>
    </view>
  </view>
</view>
"""

target = r'e:\develop\sanqi-meal\miniprogram\pages\settings\index.wxml'
with open(target, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Written {len(content.encode("utf-8"))} bytes to {target}')
